import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from './store.ts';
import { assertMutable, finalVerdict, summarize } from '../shared/domain.ts';
import type { ComponentResult, Person, Photo, Round, SampleKind, Standard, Task, TaskListItem, TaskView, Verdict } from '../shared/types.ts';

export class ApiError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export const person: Person = { id: 'QA018', name: '王敏' };
const now = () => new Date().toISOString();
const sampleFiles: Record<SampleKind, string> = { pass: 'reference.png', fail: 'mismatch.png', four: 'four-components.png', quality: 'reference.png' };
const sampleHashes: Record<string, SampleKind> = {
  ccfe295230463618ac5c8c73a6e248057dd47e680d2807b095bfb2d716321b97: 'pass',
  b0926e327952e093b2895bfa852bacad76e47e03efe3c552b5a9d15d7b9d9afa: 'fail',
  '5225aa3abdf7f73a9a779da30f3ef312a0f8ff1143312b9d935ac80ee64d848b': 'four',
};
const standard: Standard = { id: 'STD-358', version: 1, material: 'MAT-358-08', supplier: '华信电子', image: '/assets/detail-1.png', lines: ['SV358', 'A26', '0147'], description: '核对型号丝印、文字顺序、Logo与外观。当前为虚构标准，仅用于本地流程试用。' };
function escapeMarkdown(s: string) { return s.replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&'); }

export class InspectionService {
  store: Store; directory: string; root: string; interval: number; queue: string[] = []; worker = false; closing = false;
  constructor(directory: string, root: string, interval = 1200) {
    this.directory = directory; this.root = root; this.interval = interval; this.store = new Store(directory);
    if (!this.store.tasks().length) for (const [id, material, supplier] of [['IQCF26090500016', 'MAT-358-08', '华信电子'], ['IQCF26090500017', 'MAT-358-08', '华信电子'], ['IQCF26090500018', 'MAT-725-16', '远成电子']]) this.store.saveTask({ id, number: id, material, supplier, standard: material === 'MAT-358-08' ? standard : null, roundId: null, effectiveRoundId: null });
    for (const round of this.store.rounds()) {
      if (['queued', 'running'].includes(round.status)) {
        for (const p of round.photos) if (['queued', 'running'].includes(p.status)) { p.status = 'error'; p.message = '服务已重启，已完成的结果保留，请重新检测未完成部分。'; }
        round.status = 'draft'; round.revision++; this.store.saveRound(round);
      } else if (round.status === 'submitting') {
        round.status = 'submit_failed'; round.revision++;
        if (round.transfer) { round.transfer.status = 'failed'; round.transfer.message = '回填时服务重启，尚未确认保存成功，请重试。'; }
        this.store.saveRound(round);
      }
    }
  }
  task(id: string) { const t = this.store.task(id); if (!t) throw new ApiError(404, '没有找到这项检验任务。'); return t; }
  round(id: string) { const r = this.store.round(id); if (!r) throw new ApiError(404, '没有找到本轮检测记录。'); return r; }
  view(id: string): TaskView { const task = this.task(id), round = task.roundId ? this.store.round(task.roundId) : null; return { task, round, effective: task.effectiveRoundId ? this.store.round(task.effectiveRoundId) : null, summary: round ? summarize(round) : null }; }
  list(): TaskListItem[] { return this.store.tasks().map(t => { const round = t.roundId ? this.store.round(t.roundId) : null; return { ...t, status: !t.standard ? '缺少基准' : t.effectiveRoundId ? (round?.status === 'submitted' ? '已有结果' : '重检草稿') : round ? (['queued', 'running'].includes(round.status) ? '检测中' : '未提交') : '未检测', summary: round ? summarize(round) : null }; }); }
  open(id: string) { const t = this.task(id); if (!t.roundId && t.standard) this.newRound(id, false); return this.view(id); }
  newRound(id: string, reuse: boolean): TaskView {
    const t = this.task(id); if (!t.standard) throw new ApiError(409, '缺少正品基准，请联系管理员');
    const previous = t.roundId ? this.round(t.roundId) : null;
    if (previous && previous.status !== 'submitted') throw new ApiError(409, '当前还有未提交的检测草稿，请先继续本轮。');
    const r: Round = { id: randomUUID(), taskId: id, number: (previous?.number ?? 0) + 1, revision: 1, status: 'draft', createdAt: now(), standard: structuredClone(t.standard), instruction: previous?.instruction ?? '', instructionVersion: 1, nextPhotoSequence: previous?.nextPhotoSequence ?? 1, photos: [], transfer: null };
    if (reuse && previous) r.photos = previous.photos.map(p => ({ ...structuredClone(p), id: randomUUID(), status: 'pending', message: '', components: [] }));
    t.roundId = r.id;
    this.store.transaction(() => { this.store.saveRound(r); this.store.saveTask(t); });
    return this.view(id);
  }
  mutable(id: string, revision: number): Round {
    const r = this.round(id); if (r.revision !== revision) throw new ApiError(409, '检测内容已更新，已为你保留最新状态，请查看后重试。');
    try { assertMutable(r); } catch (e) { throw new ApiError(409, (e as Error).message); }
    return r;
  }
  saveMutation(r: Round) { r.revision++; r.transfer = null; r.status = r.photos.length && r.photos.every(p => p.status === 'ready') ? 'ready' : 'draft'; this.store.saveRound(r); return this.view(r.taskId); }
  async addPhoto(id: string, revision: number, input: { bytes: Buffer; filename: string; width: number; height: number; sample?: SampleKind; replaceId?: string; clientId?: string }, actor: Person): Promise<TaskView> {
    if (input.clientId && this.round(id).photos.some(p => p.uploadKey === input.clientId)) return this.view(this.round(id).taskId);
    this.mutable(id, revision);
    const ext = input.bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? '.png' : input.bytes[0] === 255 && input.bytes[1] === 216 && input.bytes[2] === 255 ? '.jpg' : input.bytes.subarray(0,4).toString() === 'RIFF' && input.bytes.subarray(8,12).toString() === 'WEBP' ? '.webp' : null;
    if (!ext) throw new ApiError(415, '仅支持有效的 JPG、PNG 或 WebP 图片。');
    if (!input.bytes.length || input.bytes.length > 20 * 1024 * 1024) throw new ApiError(413, '单张照片请控制在20MB以内，原图不会压缩后替代保存。');
    if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1 || input.width > 30000 || input.height > 30000) throw new ApiError(400, '照片尺寸无法读取，请换一张照片。');
    const file = randomUUID() + ext, hash = createHash('sha256').update(input.bytes).digest('hex');
    await mkdir(path.join(this.directory, 'files'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(this.directory, 'files', file), input.bytes, { mode: 0o600 });
    const r = this.mutable(id, revision), old = input.replaceId ? r.photos.find(p => p.id === input.replaceId) : null;
    if (input.replaceId && !old) throw new ApiError(404, '要替换的照片已不存在，请刷新后重试。');
    const photo: Photo = { id: randomUUID(), uploadKey: input.clientId, sequence: old?.sequence ?? r.nextPhotoSequence++, filename: path.basename(input.filename).slice(0,160), file, url: '/api/files/' + file, hash, width: input.width, height: input.height, sample: input.sample ?? sampleHashes[hash] ?? null, status: 'pending', message: '', components: [] };
    if (old) r.photos[r.photos.indexOf(old)] = photo; else r.photos.push(photo);
    this.store.audit(r, actor, old ? 'photo.replace' : 'photo.add', { oldId: old?.id, photoId: photo.id, hash });
    return this.saveMutation(r);
  }
  async addSample(id: string, revision: number, sample: SampleKind, replaceId: string | undefined, actor: Person) {
    if (!Object.hasOwn(sampleFiles, sample)) throw new ApiError(400, '请选择一种内置样例。');
    const bytes = await readFile(path.join(this.root, 'fixtures/inspection', sampleFiles[sample]));
    return this.addPhoto(id, revision, { bytes, filename: '内置样例-' + sampleFiles[sample], width: 1536, height: 1024, sample, replaceId }, actor);
  }
  remove(id: string, revision: number, photoId: string, actor: Person) { const r = this.mutable(id, revision); if (!r.photos.some(p => p.id === photoId)) throw new ApiError(404, '照片已被移除。'); r.photos = r.photos.filter(p => p.id !== photoId); this.store.audit(r, actor, 'photo.remove', { photoId }); return this.saveMutation(r); }
  notes(id: string, revision: number, instruction: string, actor: Person) {
    const r = this.mutable(id, revision);
    if (instruction.length > 4000) throw new ApiError(400, '本次检测说明请控制在4000字以内。');
    if (instruction === r.instruction) return this.view(r.taskId);
    r.instruction = instruction; r.instructionVersion++;
    for (const p of r.photos) { p.status = 'pending'; p.message = ''; for (const c of p.components) { c.ai = null; c.review = null; } }
    this.store.audit(r, actor, 'instruction.update', { instruction, version: r.instructionVersion }); return this.saveMutation(r);
  }
  review(id: string, revision: number, componentId: string, verdict: Verdict, reason: string, actor: Person) {
    const r = this.mutable(id, revision), c = r.photos.flatMap(p => p.components).find(c => c.id === componentId);
    if (!c?.ai || c.ai.instructionVersion !== r.instructionVersion) throw new ApiError(409, '这件元件尚无当前检测说明下的有效结果。');
    if (!['PASS', 'FAIL'].includes(verdict) || !reason.trim() || reason.length > 1000) throw new ApiError(400, '请选择合格／不合格，并填写修改原因（1000字以内）。');
    const change = { id: randomUUID(), verdict, reason: reason.trim(), person: actor, at: now(), instructionVersion: r.instructionVersion };
    c.review = change; c.reviewHistory.push(change); this.store.audit(r, actor, 'verdict.correct', { componentId, ai: c.ai, change }); return this.saveMutation(r);
  }
  analyze(id: string, revision: number) {
    const r = this.mutable(id, revision);
    const photos = r.photos.filter(p => p.status !== 'ready');
    if (!photos.length) throw new ApiError(409, r.photos.length ? '所有照片已经检测完成。' : '请先添加照片。');
    for (const p of photos) { p.status = 'queued'; p.message = ''; }
    r.status = 'queued'; r.revision++; r.transfer = null; this.store.saveRound(r); this.queue.push(id); void this.consume(); return this.view(r.taskId);
  }
  async consume() {
    if (this.worker) return; this.worker = true;
    try { while (this.queue.length && !this.closing) {
      const id = this.queue.shift()!;
      try { await this.process(id); } catch(error) {
        if(this.closing)return;
        console.error('模拟检测任务失败',error);
        const r=this.round(id);for(const p of r.photos)if(['queued','running'].includes(p.status)){p.status='error';p.message='检测没有完成，已完成结果保留，请重试。';}
        r.status='draft';r.revision++;this.store.saveRound(r);
      }
    } } finally { this.worker = false; }
  }
  async process(id: string) {
    let r = this.round(id); r.status = 'running'; r.revision++; this.store.saveRound(r);
    for (const photo of r.photos.filter(p => p.status === 'queued')) {
      if (this.closing) return;
      r = this.round(id); const p = r.photos.find(p => p.id === photo.id)!; p.status = 'running'; r.revision++; this.store.saveRound(r);
      await delay(this.interval);
      if (this.closing) return;
      if (!p.sample) { p.status = 'error'; p.message = '照片已保存。本阶段尚未接入真实模型，请使用内置样例体验检测；不会为这张照片伪造判定。'; }
      else if (p.sample === 'quality') { p.status = 'quality'; p.message = '图片质量过低，请重新拍照（内置质量反馈状态示例）。'; }
      else {
        const count = p.sample === 'four' ? 4 : 1;
        if (p.components.length !== count) p.components = Array.from({ length: count }, (_, index): ComponentResult => ({ id: randomUUID(), label: 'P' + String(p.sequence).padStart(3,'0') + '-' + String(index + 1).padStart(2,'0'), index, bbox: count === 4 ? [index % 2 * .5, Math.floor(index / 2) * .5, .5, .5] : [0,0,1,1], ai: null, aiHistory: [], review: null, reviewHistory: [] }));
        this.store.saveRound(r);
        for (const c of p.components) {
          if (this.closing) return;
          if (c.ai?.instructionVersion === r.instructionVersion) continue;
          await delay(this.interval); if(this.closing)return;
          const fail = p.sample === 'fail' || (p.sample === 'four' && c.index === 2);
          c.ai = { verdict: fail ? 'FAIL' : 'PASS', lines: [fail ? 'SV385' : 'SV358','A26','0147'], confidence: p.sample === 'four' && c.index === 1 ? .74 : .97, reason: fail ? '型号末两位顺序不同：实拍85，正品58。' : c.index === 1 && count === 4 ? '字形与正品一致，字符边缘反光，建议按需复核。' : '丝印文字、排列与正品样例一致。', instructionVersion: r.instructionVersion };
          c.aiHistory.push(structuredClone(c.ai));
          r.revision++; this.store.saveRound(r);
        }
        if(this.closing)return;
        p.status = 'ready';
      }
      r.revision++; this.store.saveRound(r);
    }
    if (!this.closing) { r = this.round(id); r.status = r.photos.every(p => p.status === 'ready') ? 'ready' : 'draft'; r.revision++; this.store.saveRound(r); }
  }
  submit(id: string, revision: number, actor: Person, simulateFailure = false) {
    const r = this.round(id);
    if (r.status === 'submitted' || r.status === 'submitting') return this.view(r.taskId);
    this.mutable(id, revision);
    const summary = summarize(r); if (!summary.canSubmit) throw new ApiError(409, '还有未处理、需重拍或缺少明确结论的照片，不能部分提交。');
    const key = r.transfer?.status === 'failed' ? r.transfer.key : `${r.id}:${r.revision}`;
    r.status = 'submitting'; r.transfer = { id: r.transfer?.id ?? randomUUID(), key, revision: r.revision, status: 'sending', message: '正在向模拟MES保存丝印检测项…', at: now() }; r.submittedBy = actor; r.revision++; this.store.saveRound(r);
    void this.writeback(id, simulateFailure).catch(error => { const latest = this.round(id); latest.status = 'submit_failed'; if (latest.transfer) { latest.transfer.status = 'failed'; latest.transfer.message = '保存失败：' + (error as Error).message; } latest.revision++; this.store.saveRound(latest); });
    return this.view(r.taskId);
  }
  async writeback(id: string, fail: boolean) {
    await delay(Math.max(100, this.interval)); if (this.closing) return;
    const r = this.round(id), t = this.task(r.taskId), transfer = r.transfer!;
    if (fail) { r.status = 'submit_failed'; transfer.status = 'failed'; transfer.message = '模拟MES暂时不可用，结果已保留，请重试。'; r.revision++; this.store.saveRound(r); return; }
    const prior = this.store.db.prepare('SELECT data FROM receipts WHERE key=?').get(transfer.key);
    const receipt = prior ? JSON.parse(String(prior.data)).receipt : 'MOCK-' + randomUUID().slice(0,8).toUpperCase();
    transfer.status = 'success'; transfer.receipt = receipt; transfer.message = '已保存到模拟MES，未连接公司MES。'; transfer.at = now(); transfer.reportUrl = '/api/rounds/' + id + '/report.md';
    r.status = 'submitted'; r.revision++; t.effectiveRoundId = r.id;
    await mkdir(path.join(this.directory, 'reports'), { recursive: true, mode: 0o700 });
    await writeFile(path.join(this.directory, 'reports', id + '.md'), this.report(r), { mode: 0o600 });
    this.store.transaction(() => { this.store.db.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?)').run(transfer.key, JSON.stringify({ receipt, roundId: id, verdict: summarize(r).verdict, badCount: summarize(r).fail })); this.store.saveRound(r); this.store.saveTask(t); this.store.audit(r, r.submittedBy!, 'mes.mock.saved', { key: transfer.key, receipt }); });
  }
  report(r: Round): string {
    const s = summarize(r), lines = ['# 丝印检测报告（本地模拟）', '', '> 仅用于流程验证。识别为内置样例预设结果，未连接真实模型与公司MES。', '', `- 检验单号：${r.taskId}`, `- 第${r.number}轮，标准版本：${r.standard.version}，检测说明版本：${r.instructionVersion}`, `- 结论：${s.verdict === 'PASS' ? '合格' : s.verdict === 'FAIL' ? '不合格' : '尚未完成'}`, `- 元件数：${s.total}；不良数：${s.fail}`, '- 操作人：' + (r.submittedBy ? `${r.submittedBy.name} ${r.submittedBy.id}` : '尚未回填'), '', '## 检测依据', escapeMarkdown(r.standard.description), '', '## 现场检测说明（本次优先）', escapeMarkdown(r.instruction || '无补充说明'), '', '说明的自然语言理解将在真实模型阶段验证，本阶段预设样例结果不会理解或执行说明。', ''];
    for (const p of r.photos) {
      lines.push(`## 照片 P${String(p.sequence).padStart(3,'0')}`, `![原始照片](${p.url})`, '', escapeMarkdown(p.filename));
      for (const c of p.components) {
        lines.push(`### ${c.label} · ${finalVerdict(c) === 'PASS' ? '合格' : finalVerdict(c) === 'FAIL' ? '不合格' : '未完成'}`, '', '| 行 | 实拍识别原文 | 正品原文 |', '| --- | --- | --- |');
        for (let i = 0; i < Math.max(c.ai?.lines.length ?? 0, r.standard.lines.length); i++) lines.push(`| ${i+1} | ${escapeMarkdown(c.ai?.lines[i] ?? '')} | ${escapeMarkdown(r.standard.lines[i] ?? '')} |`);
        lines.push('', escapeMarkdown(c.ai?.reason ?? p.message));
        if (c.review) lines.push(`人工修正：${c.review.person.name} ${c.review.person.id}，${c.review.at}，原因：${escapeMarkdown(c.review.reason)}。AI原判${c.ai?.verdict}保留。`);
      }
    }
    return lines.join('\n');
  }
}
