"""将本轮本机完整记录提炼为可提交的报告材料；不收集用户照片、会话或凭证。"""
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'outputs/real-vision-20261018'

def compact(filename,override=False):
    records=json.loads((OUT/filename).read_text(encoding="utf-8"));rows=[]
    expected={'REALVISION1':[['SV358','A26','0147']],'REALVISION2':[['SV358','A26','0147'],['SV385','A26','0147']],'REALVISION3':[['SV358','A26','0147']]*3}
    for r in records:
        parts=[]
        for p in r['photos']:
            for c in p['components']:
                ai=c['ai'];raw=None
                if ai:
                    raw=json.loads((Path(r['state'])/'vision-records'/ai['rawRecord']).read_text(encoding="utf-8"))['data']
                truth=expected[r['id']][c['index']];verdict='FAIL' if truth[0]=='SV385' and not override else 'PASS'
                parts.append({'label':c['label'],'expectedLines':truth,'expectedVerdict':verdict,'ai':ai,
                    'matchesThisSyntheticCase':bool(ai and ai['lines']==truth and ai['verdict']==verdict),
                    'crop':c.get('crop'), 'rawReply':raw['response']['choices'] if raw else None,
                    'usage':raw['response'].get('usage') if raw else None,
                    'stats':raw['response']['lmstudio']['stats'] if raw else None,
                    'templateSha256':raw['response']['lmstudio']['template_source_sha256'] if raw else None,
                    'inputMetrics':raw.get('inputMetrics') if raw else None})
        rows.append({'caseId':r['id'],'scope':'repeated onsite override' if override else 'baseline',
            'sourceSha256':r['photos'][0]['hash'],'photoStatus':r['photos'][0]['status'],
            'preparation':r['photos'][0].get('preparation'),'elapsedMs':r['elapsedMs'],
            'summary':r['summary'],'resourceCheckBefore':r['resources'],'thermal':r['thermal'],
            'localEvidenceDir':str(Path(r['state']).relative_to(ROOT)),'components':parts})
    return rows

rows=compact('integrated-probe.json')
override=compact('onsite-integrated-probe.json',True)
geometry=json.loads((OUT/'preprocess-probe.json').read_text(encoding="utf-8"))
document={'experiment':'EXP-006','date':'2026-10-18','syntheticOnly':True,
    'limitations':['没有目标平板真机照片','正品裁片来自single.png，单件非独立比对','仅6件生成样本，不等于业务准确率','模型置信度未校准','YOLO未训练及实测','白板只生成留档，未批量送模型'],
    'environment':{'hardware':'Apple M2 Ultra','unifiedMemoryGiB':64,'modelIdentifier':'hr-qwen','loadedModel':'qwen3.8-27b-mlx','lmStudioReportedModelSizeGB':16.08,'lmStudioSdk':'1.5.0','python':'3.13.12','opencv':'4.14.0','pillow':'12.3.0','node':'24.14.0','opencvThreads':2,'modelConcurrency':1},
    'baseline':rows,'onsiteOverrideRepeatedCase':override,
    'cpuProbe':[{'case':r['name'],'count':len(r['result']['components']),'elapsedMs':r['result']['elapsedMs'],'workerPeakRssMiB':r['result'].get('workerPeakRssMiB'),'coverage':r['result']['coverage'],'resourcesBefore':r['result'].get('resourcesBefore'),'resourcesAfter':r['result'].get('resourcesAfter')} for r in geometry],
    'validation':{'nodeTests':23,'pythonTestGroups':2,'typecheck':'passed','productionFrontendBuild':'passed','browser':'人工操作IAB，横竖屏、真实识别、切换、原图/标注/白板、人工修正、报告、模拟回填均完成；原生文件选择器未自动化控制，multipart上传另行实际验证','previousRoundData':'旧4轮记录逐字节一致，旧19张照片保留'}}
(Path(__file__).parent/'results.json').write_text(json.dumps(document,ensure_ascii=False,indent=2)+'\n', encoding="utf-8")
print('baseline components',sum(len(r['components']) for r in rows),'all matched',all(c['matchesThisSyntheticCase'] for r in rows for c in r['components']))
