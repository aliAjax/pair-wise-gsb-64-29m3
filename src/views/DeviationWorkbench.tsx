import { useMemo, useState } from 'react'
import { Badge, Button, Dropdown, Field, Input, Option, Textarea } from '@fluentui/react-components'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from '../store'
import { confirmGapDeviation, createDeviation, qualifiedReadingAfter, REVIEWER, reviewDeviation, saveInvestigation } from '../store/haccpSlice'
import type { DecisionType, Deviation, DeviationStatus, Investigation } from '../types'

type Filter = DeviationStatus | '全部'
const fmt = (t: string) => t.replace('T', ' ').slice(0, 16)

export function DeviationWorkbench() {
  const dispatch = useDispatch<AppDispatch>()
  const state = useSelector((root: RootState) => root.haccp)
  const [status, setStatus] = useState<Filter>('全部')
  const [selectedId, setSelectedId] = useState(state.deviations[0]?.id ?? '')
  const [showCreate, setShowCreate] = useState(false)
  const [newDeviation, setNewDeviation] = useState({ batchId: state.batches[0]?.id ?? '', stepId: state.processSteps[0]?.id ?? '', title: '', severity: '一般' as const, owner: '质量工程组' })
  const rows = useMemo(() => state.deviations.filter((item) => status === '全部' || item.status === status), [state.deviations, status])
  const selected = state.deviations.find((item) => item.id === selectedId) ?? rows[0]
  const [investigation, setInvestigation] = useState<Investigation | null>(null)
  const activeInvestigation = investigation && selected ? investigation : selected?.investigation
  const selectedStep = selected ? state.processSteps.find((s) => s.id === selected.stepId) : undefined
  const selectedBatch = selected ? state.batches.find((b) => b.id === selected.batchId) : undefined
  const hasQualifiedReading = selected ? qualifiedReadingAfter(state, selected) : false

  return (
    <section className="page">
      <header className="page-head"><div><p>关键限值偏离 / 监控断档 / 调查与复核</p><h1>偏差处置工作台</h1></div><Button appearance="primary" onClick={() => setShowCreate(true)}>登记偏差</Button></header>
      <div className="toolbar"><Dropdown value={status} selectedOptions={[status]} onOptionSelect={(_, data) => setStatus(data.optionValue as Filter)}>{['全部', '待调查', '调查中', '待复核', '已关闭', '已撤销'].map((item) => <Option key={item} value={item}>{item}</Option>)}</Dropdown><span>断档由系统按当时频率自动登记；改频后未确认断档自动重算，复核通过且补录后有合格读数才能回到放行流程。</span></div>
      <div className="split-layout">
        <div className="deviation-list">{rows.map((item) => <button key={item.id} className={item.id === selected?.id ? 'active' : ''} onClick={() => { setSelectedId(item.id); setInvestigation(null) }}>
          <div><Badge color={item.severity === '重大' ? 'danger' : 'warning'}>{item.severity}</Badge><small>{item.id}</small></div>
          <strong>{item.title}</strong>
          <span>{item.batchId} · {item.owner}</span>
          <footer>
            <span><Badge appearance="tint" color={item.kind === '监控断档' ? 'brand' : item.kind === '关键限值偏离' ? 'danger' : 'informative'}>{item.kind}</Badge> <Badge appearance="tint">{item.status}</Badge>{item.gapConfirmed && <Badge appearance="outline" color="success">已确认固定</Badge>}</span>
            <span>{item.dueDate} 截止</span>
          </footer>
        </button>)}</div>
        {selected && selectedBatch && <div className="record-panel">
          <div className="record-title"><div><span>{selected.id} · V{selected.version}</span><h2>{selected.title}</h2></div><Badge color={selected.severity === '重大' ? 'danger' : 'warning'}>{selected.status}</Badge></div>

          {selected.kind === '监控断档' && <div className="gap-detail">
            <dl>
              <div><dt>控制点</dt><dd>{selectedStep?.name}（{selectedStep?.controlPoint}）</dd></div>
              <div><dt>断档窗口</dt><dd>{fmt(selected.gapFrom)} → {fmt(selected.gapTo)}</dd></div>
              <div><dt>判定依据</dt><dd>窗口起点当时生效频率</dd></div>
              <div><dt>判定状态</dt><dd>{selected.gapConfirmed ? '已确认固定（之后改频不重算）' : '未确认（改频将自动重算/撤销）'}</dd></div>
            </dl>
            {!selected.gapConfirmed && selected.status !== '已撤销' && selected.status !== '已关闭' &&
              <Button size="small" onClick={() => dispatch(confirmGapDeviation({ id: selected.id, note: '' }))}>确认该断档判定（固定不再重算）</Button>}
            {selected.status === '已撤销' && <p className="validation-text">已随频率变更重算撤销：{selected.revokedReason}</p>}
          </div>}

          {selected.status !== '已撤销' && selected.status !== '已关闭' && <>
            <Field label="原因判断"><Textarea value={activeInvestigation?.cause ?? ''} onChange={(_, data) => setInvestigation({ ...(activeInvestigation ?? selected.investigation), cause: data.value })} /></Field>
            <Field label="证据摘要（补录读数须说明监测/录入时间差）"><Textarea value={activeInvestigation?.evidence ?? ''} onChange={(_, data) => setInvestigation({ ...(activeInvestigation ?? selected.investigation), evidence: data.value })} /></Field>
            <Field label="处置分支"><Dropdown value={activeInvestigation?.decision} selectedOptions={[activeInvestigation?.decision ?? '返工']} onOptionSelect={(_, data) => setInvestigation({ ...(activeInvestigation ?? selected.investigation), decision: data.optionValue as DecisionType })}>{['返工', '报废', '让步接收'].map((item) => <Option key={item} value={item} text={item}>{item}</Option>)}</Dropdown></Field>
            <Field label="返工或报废指令"><Textarea value={activeInvestigation?.reworkInstruction ?? ''} onChange={(_, data) => setInvestigation({ ...(activeInvestigation ?? selected.investigation), reworkInstruction: data.value })} /></Field>
          </>}
          {(selected.status === '已关闭' || selected.status === '已撤销') && <div className="closed-note">
            <p><b>原因：</b>{selected.investigation.cause || '—'}</p>
            <p><b>证据：</b>{selected.investigation.evidence || '—'}</p>
            <p><b>复核：</b>{selected.reviewer} · {selected.reviewNote}</p>
          </div>}

          {selected.kind !== '手工登记' && selected.status !== '已撤销' && <p className={hasQualifiedReading ? 'hint-text ok' : 'validation-text'}>
            {hasQualifiedReading
              ? '该控制点在断档结束/偏离读数之后已有合格读数（含补录），满足复核前置。'
              : '复核前置未满足：断档结束/偏离读数之后尚无合格读数，请先在批次中录入或补录合格复检读数。'}
          </p>}

          {selected.status !== '已撤销' && selected.status !== '已关闭' && <div className="record-actions">
            <Button disabled={!activeInvestigation?.cause || !activeInvestigation?.evidence} onClick={() => dispatch(saveInvestigation({ id: selected.id, investigation: activeInvestigation! }))}>提交调查</Button>
            <Button appearance="primary" disabled={selected.status !== '待复核' || (selected.kind !== '手工登记' && !hasQualifiedReading)} onClick={() => dispatch(reviewDeviation({ id: selected.id, approved: true, note: '调查证据充分，纠偏措施可执行，断档后有合格读数。', reviewer: REVIEWER }))}>复核通过并回放行流程</Button>
          </div>}
          {selected.status === '待复核' && <Button appearance="subtle" onClick={() => dispatch(reviewDeviation({ id: selected.id, approved: false, note: '需补充设备故障诊断与补录读数证据。', reviewer: REVIEWER }))}>退回补充证据</Button>}
        </div>}
      </div>
      {showCreate && <div className="edit-panel">
        <h3>手工登记偏差</h3>
        <div className="edit-grid">
          <Field label="批次"><Dropdown value={newDeviation.batchId} selectedOptions={[newDeviation.batchId]} onOptionSelect={(_, data) => setNewDeviation({ ...newDeviation, batchId: data.optionValue ?? '' })}>{state.batches.map((item) => <Option key={item.id} value={item.id} text={`${item.id} ${item.product}`}>{item.id} {item.product}</Option>)}</Dropdown></Field>
          <Field label="控制点"><Dropdown value={newDeviation.stepId} selectedOptions={[newDeviation.stepId]} onOptionSelect={(_, data) => setNewDeviation({ ...newDeviation, stepId: data.optionValue ?? '' })}>{state.processSteps.map((item) => <Option key={item.id} value={item.id} text={item.name}>{item.name}</Option>)}</Dropdown></Field>
          <Field label="偏差标题"><Input value={newDeviation.title} onChange={(_, data) => setNewDeviation({ ...newDeviation, title: data.value })} /></Field>
        </div>
        <div className="record-actions"><Button onClick={() => setShowCreate(false)}>取消</Button><Button appearance="primary" disabled={!newDeviation.title || !newDeviation.batchId} onClick={() => { dispatch(createDeviation(newDeviation)); setShowCreate(false) }}>创建并冻结批次</Button></div>
      </div>}
    </section>
  )
}
