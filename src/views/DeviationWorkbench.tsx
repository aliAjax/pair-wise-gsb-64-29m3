import { useMemo, useState } from 'react'
import { Badge, Button, Dropdown, Field, Input, Option, Textarea } from '@fluentui/react-components'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from '../store'
import { createDeviation, reviewDeviation, saveInvestigation } from '../store/haccpSlice'
import type { DecisionType, Deviation, Investigation } from '../types'
import { hasQualifiedReadingAfterBackfill } from '../services/frequency'

export function DeviationWorkbench() {
  const dispatch = useDispatch<AppDispatch>()
  const state = useSelector((root: RootState) => root.haccp)
  const [status, setStatus] = useState<Deviation['status'] | '全部'>('全部')
  const [selectedId, setSelectedId] = useState(state.deviations[0]?.id ?? '')
  const [showCreate, setShowCreate] = useState(false)
  const [newDeviation, setNewDeviation] = useState({ batchId: state.batches[0]?.id ?? '', stepId: state.processSteps[0]?.id ?? '', title: '', severity: '一般' as const, owner: '质量工程组' })
  const rows = useMemo(() => state.deviations.filter((item) => status === '全部' || item.status === status), [state.deviations, status])
  const selected = state.deviations.find((item) => item.id === selectedId) ?? rows[0]
  const [investigation, setInvestigation] = useState<Investigation | null>(null)
  const activeInvestigation = investigation?.cause === selected?.investigation.cause ? investigation : selected?.investigation

  const gap = selected?.kind === '监控断档' ? state.gaps.find((g) => g.key === selected.gapKey) : undefined
  const batch = selected ? state.batches.find((b) => b.id === selected.batchId) : undefined
  const gapNeedsBackfillProof = !!(gap && batch && batch.monitoring.some(
    (r) => r.stepId === gap.stepId && r.backfilled && r.recordedAt >= gap.startAt && r.recordedAt <= gap.endAt))
  const backfillProofReady = !!(gap && batch && hasQualifiedReadingAfterBackfill(gap, batch.monitoring, state.processSteps))
  const approveBlocked = !!selected && selected.status === '待复核' && selected.kind === '监控断档' && gapNeedsBackfillProof && !backfillProofReady
  const step = selected ? state.processSteps.find((s) => s.id === selected.stepId) : undefined

  return (
    <section className="page">
      <header className="page-head"><div><p>关键限值偏离 / 监控断档 · 调查与复核</p><h1>偏差处置工作台</h1></div><Button appearance="primary" onClick={() => setShowCreate(true)}>登记限值偏差</Button></header>
      <div className="toolbar"><Dropdown value={status} selectedOptions={[status]} onOptionSelect={(_, data) => setStatus(data.optionValue as typeof status)}>{['全部', '待调查', '调查中', '待复核', '已关闭'].map((item) => <Option key={item} value={item}>{item}</Option>)}</Dropdown><span>断档偏差由批次页从未确认断档登记，重复重算不重复开偏差。</span></div>
      <div className="split-layout">
        <div className="deviation-list">{rows.map((item) => <button key={item.id} className={item.id === selected?.id ? 'active' : ''} onClick={() => { setSelectedId(item.id); setInvestigation(null) }}>
          <div><Badge color={item.severity === '重大' ? 'danger' : 'warning'}>{item.severity}</Badge><small>{item.id}</small></div>
          <strong>{item.title}</strong>
          <span>{item.batchId} · {item.owner}</span>
          <footer>
            <Badge appearance="tint" color={item.kind === '监控断档' ? 'brand' : 'informative'}>{item.kind}</Badge>
            <Badge appearance="tint">{item.status}</Badge>
            <span>{item.dueDate} 截止</span>
          </footer>
        </button>)}</div>
        {selected && <div className="record-panel">
          <div className="record-title"><div><span>{selected.id} · V{selected.version}</span><h2>{selected.title}</h2></div><Badge color={selected.severity === '重大' ? 'danger' : 'warning'}>{selected.status}</Badge></div>

          {selected.kind === '监控断档' && gap && <div className="gap-evidence">
            <p><strong>断档依据（{step?.name}）</strong>：{gap.startAt.replace('T', ' ').slice(5, 16)} 起、超时{gap.overdueMinutes}分钟，结束于{gap.endKind === '改频时刻' ? '改频时刻' : '下一读数'}；断档判定修订 V{gap.revision}。</p>
            {gap.segments.map((seg, i) => <p key={i} className="muted">适用频率段：{seg.from.replace('T', ' ').slice(5, 16)}–{seg.to.replace('T', ' ').slice(5, 16)}，该段超时{seg.overdueMinutes}分钟。</p>)}
            {gapNeedsBackfillProof && <p className={backfillProofReady ? 'ready-text' : 'validation-text'}>
              {backfillProofReady ? '补录后已存在合格常规读数，满足复核条件。' : '该断档含补录读数：补录读数本身不能作为恢复依据，必须在补录后取得合格读数才能复核通过。'}
            </p>}
          </div>}

          <Field label="原因判断"><Textarea value={activeInvestigation?.cause ?? ''} onChange={(_, data) => setInvestigation({ ...(activeInvestigation ?? selected.investigation), cause: data.value })} /></Field>
          <Field label="证据摘要（含漏测时段、补录与录入时间说明）"><Textarea value={activeInvestigation?.evidence ?? ''} onChange={(_, data) => setInvestigation({ ...(activeInvestigation ?? selected.investigation), evidence: data.value })} /></Field>
          <Field label="处置分支"><Dropdown value={activeInvestigation?.decision} selectedOptions={[activeInvestigation?.decision ?? '返工']} onOptionSelect={(_, data) => setInvestigation({ ...(activeInvestigation ?? selected.investigation), decision: data.optionValue as DecisionType })}>{['返工', '报废', '让步接收'].map((item) => <Option key={item} value={item} text={item}>{item}</Option>)}</Dropdown></Field>
          <Field label="返工或报废指令"><Textarea value={activeInvestigation?.reworkInstruction ?? ''} onChange={(_, data) => setInvestigation({ ...(activeInvestigation ?? selected.investigation), reworkInstruction: data.value })} /></Field>
          <div className="record-actions">
            <Button disabled={!activeInvestigation?.cause || !activeInvestigation?.evidence} onClick={() => dispatch(saveInvestigation({ id: selected.id, investigation: activeInvestigation! }))}>提交调查</Button>
            <Button appearance="primary" disabled={selected.status !== '待复核' || approveBlocked} title={approveBlocked ? '需先在批次页补录后取得合格读数' : ''} onClick={() => dispatch(reviewDeviation({ id: selected.id, approved: true, note: selected.kind === '监控断档' ? '断档原因已查明，纠偏有效，补录后合格读数已确认。' : '调查证据充分，纠偏措施可执行。', reviewer: '质量负责人 秦岚' }))}>复核通过</Button>
          </div>
          <Button appearance="subtle" disabled={selected.status !== '待复核'} onClick={() => dispatch(reviewDeviation({ id: selected.id, approved: false, note: '需补充设备故障诊断与漏测时段记录。', reviewer: '质量负责人 秦岚' }))}>退回补充证据</Button>
          {approveBlocked && <p className="validation-text">复核被阻止：请在批次页追加补录后的合格读数，频率引擎重算后再复核。</p>}
        </div>}
      </div>
      {showCreate && <div className="edit-panel">
        <h3>登记关键限值偏差</h3>
        <div className="edit-grid">
          <Field label="批次"><Dropdown value={newDeviation.batchId} selectedOptions={[newDeviation.batchId]} onOptionSelect={(_, data) => setNewDeviation({ ...newDeviation, batchId: data.optionValue ?? '' })}>{state.batches.map((item) => <Option key={item.id} value={item.id} text={`${item.id} ${item.product}`}>{item.id} {item.product}</Option>)}</Dropdown></Field>
          <Field label="控制点"><Dropdown value={newDeviation.stepId} selectedOptions={[newDeviation.stepId]} onOptionSelect={(_, data) => setNewDeviation({ ...newDeviation, stepId: data.optionValue ?? '' })}>{state.processSteps.map((item) => <Option key={item.id} value={item.id} text={item.name}>{item.name}</Option>)}</Dropdown></Field>
          <Field label="偏差标题"><Input value={newDeviation.title} onChange={(_, data) => setNewDeviation({ ...newDeviation, title: data.value })} /></Field>
        </div>
        <div className="record-actions"><Button onClick={() => setShowCreate(false)}>取消</Button><Button appearance="primary" disabled={!newDeviation.title || !newDeviation.batchId} onClick={() => { dispatch(createDeviation(newDeviation)); setShowCreate(false) }}>创建并隔离批次</Button></div>
      </div>}
    </section>
  )
}
