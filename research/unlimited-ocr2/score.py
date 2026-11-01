"""只评估文字证据；全文计数不冒充元件定位或合格判定。"""
from collections import Counter
import html
from html.parser import HTMLParser
import re


class PlainHTML(HTMLParser):
    def __init__(self):
        super().__init__(); self.parts=[]
    def handle_data(self,data):
        self.parts.append(data)


def plain_text(raw):
    # UOCR2 的框/块标签不能成为识别文字。保留所有真实文本，不凭标准改字。
    text=re.sub(r'<BLOCK>[^\n]*?\[[^\]]*\]<FORK>', '\n',raw)
    text=re.sub(r'<\|det\|>.*?<\|/det\|>', '\n',text,flags=re.S)
    text=re.sub(r'<\|[^>]*\|>|<PAGE>|<FORK>|<BLOCK>', '\n',text)
    parser=PlainHTML(); parser.feed(text)
    return html.unescape('\n'.join(parser.parts))


def code_counts(raw):
    # 这一批真值都是大写代码；不合并 O/0、I/1、S/5、8/B。
    return Counter(re.findall(r'[A-Z0-9]+',plain_text(raw).upper()))


def score(raw,parts,complete=True):
    expected=Counter(p['primary'] for p in parts); actual=code_counts(raw)
    matched=sum(min(n,actual[code])for code,n in expected.items())
    anomalies=[p for p in parts if p['primary']!=p.get('reference',p['primary'])]
    bad=Counter(p['primary'] for p in anomalies)
    result={'expected_primary_counts':dict(expected),'observed_code_counts':dict(actual),
            'primary_count_matches':matched,'primary_count_total':len(parts),
            'anomaly_code_matches':sum(min(n,actual[c])for c,n in bad.items()),
            'anomaly_code_total':len(anomalies),'complete_output':complete,
            'metric_notice':'全文完整主码计数；不证明文字属于正确元件，也不生成检验结论。'}
    if len(parts)==1:
        p=parts[0]
        result.update(primary_exact=p['primary'] in actual,
                      all_required_exact=all(c in actual for c in p['required']),
                      false_reference_transcription=p['primary']!=p.get('reference',p['primary'])
                          and p.get('reference') in actual)
    return result
