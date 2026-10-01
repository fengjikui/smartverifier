from __future__ import annotations
import hashlib
import json
from pathlib import Path
import time
import uuid
from .domain import aggregate,active_components,final_verdict


def build_report(task):
    summary=aggregate(task)
    return {'schema_version':'1.0','task_id':task['id'],'mes_task_id':task['number'],'item_id':task['item_id'],
            'material':task['material'],'operator':task['inspector'],'revision':task['revision'],
            'created_at':task['created'],'reference':{k:v for k,v in task['reference'].items() if k not in ('owner','source_dir')},
            'comparison_scope':'image_and_text' if task['reference'].get('crop_file') else 'text_only',
            'summary':summary,'synthetic_test':task.get('synthetic_test',False),
            'photos':[{k:p[k] for k in ('id','label','original_file','sha256','size','flags','deleted')} for p in task['photos']],
            'samples':[{'sample_id':c['id'],'photo_id':c['photo_id'],'label':c['label'],'crop_file':c['crop_file'],
                        'box':c['box'],'transform':c['transform'],'quality_flags':c['quality_flags'],
                        'model_result':c['analysis'],'model_metadata':c.get('model_metadata'),'raw_output':c.get('raw_output'),
                        'review':c.get('review'),'final_verdict':final_verdict(c),'error':c.get('error')}
                       for c in active_components(task)],'audit':task['audit']}


def export_files(task,folder: Path):
    report=build_report(task)
    frozen=next((f for f in task.get('transfer',{}).get('files',[]) if f['role']=='structured_report'),None)
    if frozen:
        name=frozen['name'];path=folder/name
        report=json.loads(path.read_text())
    else:
        data=(json.dumps(report,ensure_ascii=False,indent=2)+'\n').encode()
        # 相同任务版本在回填审计前后也可能有不同快照，摘要文件名防止并发导出覆盖。
        name=f"report-r{task['revision']}-{hashlib.sha256(data).hexdigest()[:12]}.json"
        path=folder/name
        if not path.exists():
            temp=folder/(uuid.uuid4().hex+'.report.tmp');temp.write_bytes(data);temp.replace(path)
    files=[]
    def add(file,role,mime):
        p=folder/file
        files.append({'name':file,'role':role,'mime':mime,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),
                      'size':p.stat().st_size,'path':p})
    add(name,'structured_report','application/json')
    for photo in task['photos']:
        if photo['deleted']:continue
        add(photo['original_file'],'original_photo','image/'+('jpeg' if photo['original_file'].endswith('.jpg') else photo['original_file'].rsplit('.',1)[-1]))
        add(photo['annotation_file'],'annotated_photo','image/jpeg')
        for component in photo['components']:add(component['crop_file'],'sample_crop','image/png')
    return report,files


def mes_payload(task):
    a=aggregate(task)
    return {'schema_version':'1.0','source':'smartverifier','source_task_id':task['id'],
            'report_revision':task['revision'],'mes_task_id':task['number'],'item_id':task['item_id'],
            'expected_item_version':task['mes_item_version'],'save_mode':'item_draft','final_submit':False,
            'operator':task['inspector'],'material':task['material'],'reference_id':task['reference']['id'],
            'reference_version':task['reference']['version'],'comparison_scope':'image_and_text' if task['reference'].get('crop_file') else 'text_only',
            'conclusion':a['verdict'],'sample_count':a['sample_count'],'failed_count':a['fail_count'],
            'photo_count':a['photo_count'],'synthetic_test':task.get('synthetic_test',False)}
