import asyncio
import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
import httpx
from PIL import Image,ImageDraw,ImageFilter
from smartverifier_focus.web import create_app
from smartverifier_focus.inspection.domain import parse_result,aggregate
from smartverifier_focus.inspection.storage import InspectionStore
from smartverifier_focus.inspection.vision import locate,crop_component
from smartverifier_focus.inspection.mes import HttpMesAdapter,MesError
from smartverifier_focus.inspection.mock_mes import create_mock_mes

FIXTURES=Path(__file__).resolve().parents[3]/'fixtures'/'inspection'
PASS={'verdict':'PASS','observed_text':['SV358','A26','0147'],'features':['八个引脚'],
      'differences':[],'uncertainties':[],'summary':'可见文字与参考一致。'}
FAIL={**PASS,'verdict':'FAIL','observed_text':['SV385','A26','0147'],
      'differences':[{'category':'text','sample':'SV385','reference':'SV358','description':'型号末尾 58 与 85 不一致。'}],
      'summary':'型号文字不一致。'}


class GeometryTests(unittest.TestCase):
    def test_generated_images_have_expected_count_order_and_original_coordinates(self):
        for name,count in [('reference',1),('mismatch',1),('four-components',4)]:
            with self.subTest(name=name),Image.open(FIXTURES/(name+'.png')) as image:
                regions,flags=locate(image,mode='multi')
                self.assertEqual(count,len(regions));self.assertEqual([],flags)
                for region in regions:
                    crop,warnings,meta=crop_component(image,region)
                    self.assertGreater(crop.width,region['size'][0]);self.assertGreater(crop.height,region['size'][1])
                    self.assertLessEqual(abs(region['angle']),45)
                    self.assertEqual([],warnings)
                if count==4:
                    self.assertLess(regions[0]['center'][0],regions[1]['center'][0])
                    self.assertLess(regions[1]['center'][1],regions[2]['center'][1])

    def test_empty_overcrowded_single_mode_and_edge_are_flagged(self):
        image=Image.new('RGB',(1000,800),'white');self.assertTrue(locate(image)[1])
        draw=ImageDraw.Draw(image)
        for x in [20,210,400,590,780]:draw.rectangle((x,250,x+100,400),fill='black')
        regions,flags=locate(image,mode='multi');self.assertEqual(4,len(regions));self.assertTrue(flags)
        image=Image.new('RGB',(1000,800),'white');draw=ImageDraw.Draw(image)
        draw.rectangle((0,250,200,430),fill='black');r,_=locate(image)
        self.assertTrue(r[0]['flags'])
        with Image.open(FIXTURES/'four-components.png') as image:self.assertTrue(locate(image,mode='single')[1])

    def test_blur_is_not_enhanced_into_evidence(self):
        with Image.open(FIXTURES/'reference.png') as source:
            image=source.filter(ImageFilter.GaussianBlur(10));r,_=locate(image)
            _,flags,_=crop_component(image,r[0]);self.assertTrue(any('模糊' in f for f in flags))

    def test_json_rejects_truncated_incoherent_and_extra_fields(self):
        self.assertEqual(PASS,parse_result('```json\n'+json.dumps(PASS)+'\n```'))
        for value in ['{"verdict":', '解释：'+json.dumps(PASS),json.dumps({**PASS,'tool_call':'send'}),
                      json.dumps({**PASS,'uncertainties':['看不清']}),json.dumps({**PASS,'verdict':'FAIL'})]:
            with self.assertRaises(ValueError):parse_result(value)


class InspectionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.results=[];self.received=[];self.gate=None
        async def models():return [{'id':'test-vlm','available':True,'template':'test'}]
        async def predict(messages,model):
            self.received.append(messages)
            if self.gate:await self.gate.wait()
            value=self.results.pop(0) if self.results else PASS
            return {'choices':[{'finish_reason':'stop','message':{'content':value if isinstance(value,str) else json.dumps(value)}}]}
        self.app=create_app(self.root,predictor=predict,models_provider=models)
        self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),base_url='http://test',trust_env=False)
        await self.client.post('/api/connect',json={'key':self.app.state.store.key})
        self.service=self.app.state.inspection
        await self.client.put('/api/inspection/profile',json={'employee_id':'QA01','name':'测试人员'})
        response=await self.client.post('/api/inspection/references',data={'name':'人工确认标准','text':'SV358\nA26\n0147','approved':'true'},files={'file':('ref.png',(FIXTURES/'reference.png').read_bytes(),'image/png')})
        self.assertEqual(200,response.status_code,response.text);self.ref=response.json()

    async def asyncTearDown(self):
        jobs=list(self.app.state.tasks.values())
        for job in jobs:job.cancel()
        await asyncio.gather(*jobs,return_exceptions=True)
        await self.client.aclose();self.temp.cleanup()

    async def task(self,count=1,mode='single',auto=False,reference=None):
        number='QA-'+str(len(self.service.store.list('task',None)))
        response=await self.client.post('/api/inspection/tasks',json={'number':number,'material':'IC','reference_id':reference or self.ref['id'],'expected_count':count,'capture_mode':mode,'auto_writeback':auto})
        self.assertEqual(200,response.status_code,response.text);return response.json()

    async def upload(self,task,name='reference',request_id='request1',replace_id=''):
        response=await self.client.post('/api/inspection/tasks/'+task['id']+'/photos',data={'request_id':request_id,'replace_id':replace_id},files={'file':(name+'.png',(FIXTURES/(name+'.png')).read_bytes(),'image/png')})
        self.assertEqual(200,response.status_code,response.text);return response.json()

    async def action(self,task,suffix,data=None,status=200):
        response=await self.client.post('/api/inspection/tasks/'+task['id']+suffix,json=data or {})
        self.assertEqual(status,response.status_code,response.text);return response.json()

    async def finish(self,task):
        async with asyncio.timeout(10):
            while True:
                value=(await self.client.get('/api/inspection/tasks/'+task['id'])).json()
                if value['run']['status'] not in ('queued','running') and value.get('transfer',{}).get('status')!='sending':return value
                await asyncio.sleep(.02)

    async def test_draft_reopen_duplicate_request_and_owner_isolation(self):
        task=await self.upload(await self.task())
        again=await self.upload(task)
        self.assertEqual(1,again['summary']['sample_count'])
        response=await self.client.post('/api/inspection/tasks/'+task['id']+'/photos',data={'request_id':'different'},files={'file':('ref.png',(FIXTURES/'reference.png').read_bytes(),'image/png')})
        self.assertEqual(409,response.status_code)
        store=InspectionStore(self.root/'inspection');self.assertEqual(1,store.get('task',task['id'])['photo_counter'])
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),base_url='http://test') as other:
            self.assertEqual(401,(await other.get(task['photos'][0]['original_url'])).status_code)
            await other.post('/api/connect',json={'key':self.app.state.store.key})
            self.assertEqual(404,(await other.get('/api/inspection/tasks/'+task['id'])).status_code)
            self.assertEqual(404,(await other.get(task['reference']['image_url'])).status_code)

    async def test_dual_images_fail_requires_review_and_counts_parts_not_differences(self):
        task=await self.upload(await self.task(4,'multi'),'four-components')
        self.results=[PASS,PASS,FAIL,PASS]
        await self.action(task,'/analyze',{'model_id':'test-vlm'});task=await self.finish(task)
        self.assertEqual((3,1,0),(task['summary']['pass_count'],task['summary']['review_count'],task['summary']['fail_count']))
        self.assertEqual(2,sum(b['type']=='image_url' for b in self.received[0][1]['content']))
        await self.action(task,'/writeback',{'revision':task['revision']},409)
        c=task['photos'][0]['components'][2]
        task=await self.action(task,'/components/'+c['id']+'/review',{'verdict':'FAIL','reason':'型号末尾数字与标准不同'})
        self.assertEqual('FAIL',task['summary']['verdict']);self.assertEqual(1,task['summary']['fail_count'])
        self.assertTrue(task['summary']['can_submit'])
        await self.action(task,'/writeback',{'revision':task['revision']});task=await self.finish(task)
        self.assertEqual('saved',task['transfer']['status']);self.assertFalse(task['transfer']['receipt']['final_submission'])
        await self.action(task,'/photos/'+task['photos'][0]['id']+'/delete',status=409)

    async def test_invalid_json_never_passes_and_resume_keeps_completed_and_manual_review(self):
        task=await self.upload(await self.task(4,'multi'),'four-components')
        self.results=[PASS,'not json',PASS,PASS]
        await self.action(task,'/analyze',{'model_id':'test-vlm'});task=await self.finish(task)
        self.assertEqual(1,task['summary']['error_count']);self.assertFalse(task['summary']['can_submit'])
        bad=task['photos'][0]['components'][1]
        task=await self.action(task,'/components/'+bad['id']+'/review',{'verdict':'PASS','reason':'人工对原图逐字核对一致'})
        await self.action(task,'/analyze',{'model_id':'test-vlm'});task=await self.finish(task)
        self.assertEqual(4,len(self.received));self.assertEqual(4,task['summary']['pass_count'])

    async def test_cancel_restarts_only_unfinished_and_restart_marks_running_stopped(self):
        task=await self.upload(await self.task());self.gate=asyncio.Event()
        await self.action(task,'/analyze',{'model_id':'test-vlm'})
        await asyncio.sleep(.04);task=await self.action(task,'/stop')
        self.assertEqual('stopped',task['run']['status']);self.assertEqual(1,task['summary']['pending_count'])
        self.gate=None;await self.action(task,'/analyze',{'model_id':'test-vlm'});task=await self.finish(task)
        self.assertEqual(1,task['summary']['pass_count'])
        self.service.store.change('task',task['id'],self.service.store.get('task',task['id'])['owner'],lambda t:t['run'].update(status='running'))
        restarted=InspectionStore(self.root/'inspection')
        self.assertEqual('stopped',restarted.get('task',task['id'])['run']['status'])

    async def test_rotation_preserves_original_and_invalidates_analysis_and_replacement_does_not_reuse_id(self):
        task=await self.upload(await self.task());photo=task['photos'][0]
        original=(await self.client.get(photo['original_url'])).content
        await self.action(task,'/analyze',{'model_id':'test-vlm'});task=await self.finish(task)
        component=task['photos'][0]['components'][0]
        task=await self.action(task,'/components/'+component['id']+'/rotate')
        self.assertEqual('PENDING',task['photos'][0]['components'][0]['final_verdict'])
        self.assertIsNone(task['photos'][0]['components'][0].get('model_metadata'))
        self.assertEqual(original,(await self.client.get(photo['original_url'])).content)
        self.assertEqual(200,(await self.client.get(task['photos'][0]['components'][0]['image_url'])).status_code)
        task=await self.upload(task,'mismatch','second',photo['id'])
        self.assertEqual(1,task['summary']['sample_count']);self.assertEqual('P002',task['photos'][0]['label'])

    async def test_count_mismatch_and_stale_revision_block_writeback(self):
        task=await self.upload(await self.task(2));await self.action(task,'/analyze',{'model_id':'test-vlm'});task=await self.finish(task)
        self.assertFalse(task['summary']['can_submit']);await self.action(task,'/writeback',{'revision':task['revision']},409)
        task=await self.upload(task,'mismatch','second');await self.action(task,'/analyze',{'model_id':'test-vlm'});task=await self.finish(task)
        await self.action(task,'/writeback',{'revision':task['revision']-1},409)

    async def test_auto_writeback_only_clear_pass_and_export_preserves_frozen_report(self):
        task=await self.upload(await self.task(auto=True));await self.action(task,'/analyze',{'model_id':'test-vlm'});task=await self.finish(task)
        self.assertEqual('saved',task['transfer']['status'])
        stored=self.service.store.get('task',task['id']);report=next(f for f in stored['transfer']['files'] if f['role']=='structured_report')
        archive=await self.client.get('/api/inspection/tasks/'+task['id']+'/export')
        with zipfile.ZipFile(io.BytesIO(archive.content)) as z:
            self.assertEqual(report['sha256'],hashlib.sha256(z.read(report['name'])).hexdigest())
        again=await self.action(task,'/writeback',{'revision':task['revision']})
        self.assertEqual(task['transfer']['key'],again['transfer']['key'])
        task=await self.upload(await self.task(auto=True));self.results=[FAIL]
        await self.action(task,'/analyze',{'model_id':'test-vlm'});task=await self.finish(task)
        self.assertNotIn('transfer',task)

    async def test_text_only_standard_is_limited_to_text_and_requires_approval(self):
        response=await self.client.post('/api/inspection/references',data={'name':'文字标准','text':'SV358','approved':'false'})
        self.assertEqual(400,response.status_code)
        ref=(await self.client.post('/api/inspection/references',data={'name':'文字标准','text':'SV358','approved':'true'})).json()
        task=await self.upload(await self.task(reference=ref['id']));await self.action(task,'/analyze',{'model_id':'test-vlm'});await self.finish(task)
        self.assertEqual(1,sum(b['type']=='image_url' for b in self.received[-1][1]['content']))
        self.assertIn('text_only',self.received[-1][1]['content'][-1]['text'])

    async def test_http_contract_receipt_recovery_conflict_and_bad_hash(self):
        app=create_mock_mes(self.root/'http-mes','local-test-token-12345')
        adapter=HttpMesAdapter('http://127.0.0.1','local-test-token-12345',transport=httpx.ASGITransport(app=app))
        self.service.adapter=adapter
        task=await self.upload(await self.task());await self.action(task,'/analyze',{'model_id':'test-vlm'});task=await self.finish(task)
        await self.action(task,'/writeback',{'revision':task['revision']});task=await self.finish(task)
        self.assertEqual('saved',task['transfer']['status'],task.get('transfer'))
        stored=self.service.store.get('task',task['id']);transfer=stored['transfer']
        files=[{**f,'path':self.service.store.folder('task',task['id'])/f['name']} for f in transfer['files']]
        # 故意不给任何文件：已保存的同键重试必须先查回执，不再上传。
        receipt=await adapter.send(transfer['payload'],[],transfer['key']);self.assertEqual(task['transfer']['receipt'],receipt)
        with self.assertRaisesRegex(MesError,'版本'):await adapter.send(transfer['payload'],files,transfer['key']+'-new')
        corrupt=copy.deepcopy(files);corrupt[0]['sha256']='0'*64
        with self.assertRaisesRegex(MesError,'附件'):await adapter.send(transfer['payload'],corrupt,transfer['key']+'-corrupt')

    async def test_demo_is_explicit_and_normal_boot_does_not_create_tasks(self):
        bootstrap=(await self.client.get('/api/inspection/bootstrap')).json();self.assertEqual([],bootstrap['tasks'])
        response=await self.client.post('/api/inspection/demo',json={})
        self.assertEqual(200,response.status_code,response.text);task=response.json()
        self.assertTrue(task['synthetic_test']);self.assertEqual(4,task['summary']['sample_count']);self.assertEqual('idle',task['run']['status'])

    async def test_lost_mes_response_retries_same_snapshot_without_duplicate_save(self):
        app=create_mock_mes(self.root/'lost-response','local-test-token-12345')
        delegate=httpx.ASGITransport(app=app)
        class LostResponse(httpx.AsyncBaseTransport):
            lost=False
            async def handle_async_request(inner,request):
                response=await delegate.handle_async_request(request)
                if request.method=='PUT' and not inner.lost:
                    inner.lost=True
                    raise httpx.ReadTimeout('模拟保存成功后响应丢失',request=request)
                return response
        self.service.adapter=HttpMesAdapter('http://127.0.0.1','local-test-token-12345',transport=LostResponse())
        task=await self.upload(await self.task());await self.action(task,'/analyze',{'model_id':'test-vlm'});task=await self.finish(task)
        await self.action(task,'/writeback',{'revision':task['revision']});task=await self.finish(task)
        self.assertEqual('failed',task['transfer']['status']);key=task['transfer']['key']
        # 下载不会改写待重试的冻结报告。
        self.assertEqual(200,(await self.client.get('/api/inspection/tasks/'+task['id']+'/export')).status_code)
        await self.action(task,'/writeback',{'revision':task['revision']});task=await self.finish(task)
        self.assertEqual('saved',task['transfer']['status']);self.assertEqual(key,task['transfer']['key'])
        self.assertEqual(1,len(app.state.store.list('submission','mes')))

    async def test_multiple_tasks_queue_and_quality_warning_blocks_automatic_pass(self):
        first=await self.upload(await self.task());second=await self.upload(await self.task(auto=True))
        full=self.service.store.get('task',second['id'])
        self.service.store.change('task',second['id'],full['owner'],lambda t:t['photos'][0]['components'][0]['quality_flags'].append('测试：文字可能模糊'))
        self.gate=asyncio.Event()
        await self.action(first,'/analyze',{'model_id':'test-vlm'});await asyncio.sleep(.03)
        await self.action(second,'/analyze',{'model_id':'test-vlm'})
        second=(await self.client.get('/api/inspection/tasks/'+second['id'])).json()
        self.assertEqual('queued',second['run']['status']);self.assertEqual(1,second['run']['ahead'])
        self.gate.set();first=await self.finish(first);second=await self.finish(second)
        self.assertEqual(1,first['summary']['pass_count']);self.assertEqual(1,second['summary']['review_count']);self.assertNotIn('transfer',second)

    async def test_real_mes_rejects_unverified_identity_and_synthetic_data_before_network(self):
        adapter=HttpMesAdapter('https://mes.invalid','test-token')
        with self.assertRaisesRegex(MesError,'身份'):
            await adapter.send({'operator':{'identity_source':'local_trial'}},[],'test')
        with self.assertRaisesRegex(MesError,'合成'):
            await adapter.send({'operator':{'identity_source':'mes_verified'},'synthetic_test':True},[],'test')

    async def test_stale_concurrent_export_cannot_overwrite_frozen_report(self):
        from smartverifier_focus.inspection.report import export_files
        task=await self.upload(await self.task());await self.action(task,'/analyze',{'model_id':'test-vlm'});task=await self.finish(task)
        stale=self.service.store.get('task',task['id'])
        await self.action(task,'/writeback',{'revision':task['revision']});await self.finish(task)
        stored=self.service.store.get('task',task['id']);frozen=next(f for f in stored['transfer']['files'] if f['role']=='structured_report')
        stale['audit'].append({'event':'stale_export'})
        folder=self.service.store.folder('task',task['id']);export_files(stale,folder)
        self.assertEqual(frozen['sha256'],hashlib.sha256((folder/frozen['name']).read_bytes()).hexdigest())

    async def test_shared_browser_cookies_do_not_collide_between_ports_and_legacy_migrates(self):
        other=create_app(self.root/'other-service',models_provider=lambda:asyncio.sleep(0,result=[]))
        a=httpx.ASGITransport(app=self.app);b=httpx.ASGITransport(app=other)
        class Ports(httpx.AsyncBaseTransport):
            async def handle_async_request(inner,request):
                return await (b if request.url.port==5190 else a).handle_async_request(request)
        async with httpx.AsyncClient(transport=Ports(),base_url='http://test:5188') as browser:
            await browser.post('/api/connect',json={'key':self.app.state.store.key})
            await browser.put('/api/inspection/profile',json={'employee_id':'MAIN','name':'主工作区'})
            await browser.post('http://test:5190/api/connect',json={'key':other.state.store.key})
            await browser.put('http://test:5190/api/inspection/profile',json={'employee_id':'TEST','name':'隔离测试'})
            main=(await browser.get('/api/inspection/bootstrap')).json()
            self.assertEqual('MAIN',main['profile']['employee_id'])
            self.assertEqual(2,len([name for name in browser.cookies if name.startswith('sv_session_')]))
        current_name=next(name for name in self.client.cookies if name.startswith('sv_session_'))
        value=self.client.cookies.get(current_name)
        self.client.cookies.clear();self.client.cookies.set('sv_session',value)
        result=await self.client.get('/api/inspection/bootstrap')
        self.assertEqual('QA01',result.json()['profile']['employee_id'])
        self.assertIn(current_name,self.client.cookies)


if __name__=='__main__':unittest.main()
