import { useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Badge, Button, Dropdown, Field, Input, Option, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@fluentui/react-components'
import type { AppDispatch, RootState } from '../store'
import { addReading, confirmGapDeviations, setBatchFilter, setBatchStatus, setSelectedBatch, updateBatchStatus } from '../store/haccpSlice'
import type { BatchStatus, GapStatus } from '../types'
import { evaluateRelease, evaluateValue, formatInterval, versionAt } from '../services/frequency'
import { useCheckReleaseReadinessQuery, useLoadBatchSnapshotQuery } from '../services/api'

const statuses: Array<BatchStatus | '全部'> = ['全部', '生产中', '待复核', '可放行', '隔离中', '已放行', '已报废']
const statusColor = (status: BatchStatus) => status === '隔离中' || status === '已报废' ? 'danger' : status === '已放行' ? 'success' : status === '可放行' ? 'important' : 'warning'
const gapColor: Record<GapStatus, 'danger' | 'warning' | 'informative'> = { 未确认: 'danger', 已确认: 'warning', 已撤销: 'informative' }

function minute(t: string) { return t.replace('T', ' ').slice(5, 16) }

export function Overview() {
  const dispatch = useDispatch<AppDispatch>()
  const state = useSelector((root: RootState) => root.haccp)
  const { isFetching } = useLoadBatchSnapshotQuery()
  const [adding, setAdding] = useState(false)
  const [readingForm, setReadingForm] = useState({ stepId: state.processSteps[0]?.id ?? '', value: '', recordedAt: new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 16), operator: '', entryMode: 'backfill' as 'auto' | 'timely' | 'backfill' })
  const rows = useMemo(() => state.batches.filter((batch) => {
    const text = `${batch.id} ${batch.product} ${batch.line}`.toLowerCase()
    return (!state.batchFilter || text.includes(state.batchFilter.toLowerCase())) && (state.batchStatus === '全部' || batch.status === state.batchStatus)
  }), [state.batches, state.batchFilter, state.batchStatus])
  const selected = state.batches.find((item) => item.id === state.selectedBatchId) ?? rows[0]
  const selectedDeviations = state.deviations.filter((item) => item.batchId === selected?.id)
  const selectedGaps = state.gaps.filter((g) => g.batchId === selected?.id)

  const evaluationArg = useMemo(() => (
    selected
      ? { batch: selected, batches: state.batches, deviations: state.deviations, frequencyVersions: state.frequencyVersions, steps: state.processSteps, gaps: state.gaps }
      : null
  ), [selected, state.batches, state.deviations, state.frequencyVersions, state.processSteps, state.gaps])
  const localEvaluation = useMemo(
    () => selected ? evaluateRelease(selected, state.batches, state.deviations, state.frequencyVersions, state.processSteps, state.gaps) : null,
    [selected, state.batches, state.deviations, state.frequencyVersions, state.processSteps, state.gaps]
  )
  const { data: releaseEvaluation } = useCheckReleaseReadinessQuery(evaluationArg!, { skip: !evaluationArg })
  const evaluation = releaseEvaluation ?? localEvaluation

  const submitReading = () => {
    if (!selected || !readingForm.value || !readingForm.recordedAt) return
    dispatch(addReading({
      batchId: selected.id,
      stepId: readingForm.stepId,
      value: Number(readingForm.value),
      recordedAt: readingForm.recordedAt.length === 16 ? `${readingForm.recordedAt}:00` : readingForm.recordedAt,
      operator: readingForm.operator || '当班操作工',
      entryMode: readingForm.entryMode
    }))
    setAdding(false)
  }

  return (
    <section className="page">
      <header className="page-head"><div><p>质量运营中心 / 批次控制</p><h1>生产批次、监控断档与放行</h1></div><span className="sync-state">{isFetching ? '正在同步' : '批次快照已加载'}</span></header>
      <div className="metrics">
        <article><span>今日批次</span><strong>{state.batches.length}</strong><small>覆盖2条生产线</small></article>
        <article><span>隔离批次</span><strong>{state.batches.filter((item) => item.status === '隔离中').length}</strong><small>存在断档或偏差，禁止放行</small></article>
        <article><span>未确认断档</span><strong>{state.gaps.filter((g) => g.status === '未确认').length}</strong><small>相邻读数超过当时频率</small></article>
        <article><span>已放行</span><strong>{state.batches.filter((item) => item.status === '已放行').length}</strong><small>已完成签字</small></article>
      </div>
      <div className="toolbar">
        <Input value={state.batchFilter} onChange={(_, data) => dispatch(setBatchFilter(data.value))} placeholder="搜索批次、产品、产线" />
        <Dropdown value={state.batchStatus} selectedOptions={[state.batchStatus]} onOptionSelect={(_, data) => dispatch(setBatchStatus(data.optionValue as BatchStatus | '全部'))}>
          {statuses.map((status) => <Option key={status} value={status}>{status}</Option>)}
        </Dropdown>
        <span>断档冻结与放行结论均依据当时生效的频率版本</span>
      </div>
      <div className="split-layout">
        <div className="table-panel">
          <Table size="small" aria-label="生产批次">
            <TableHeader><TableRow><TableHeaderCell>批次</TableHeaderCell><TableHeaderCell>产品</TableHeaderCell><TableHeaderCell>产线</TableHeaderCell><TableHeaderCell>状态</TableHeaderCell><TableHeaderCell>断档</TableHeaderCell><TableHeaderCell>版本</TableHeaderCell></TableRow></TableHeader>
            <TableBody>
              {rows.map((batch) => {
                const gapCount = state.gaps.filter((g) => g.batchId === batch.id && g.status !== '已撤销' && !g.resolvedAt).length
                return <TableRow key={batch.id} onClick={() => dispatch(setSelectedBatch(batch.id))} className={batch.id === selected?.id ? 'selected-row' : ''}>
                  <TableCell>{batch.id}</TableCell><TableCell>{batch.product}</TableCell><TableCell>{batch.line}</TableCell>
                  <TableCell><Badge appearance="tint" color={statusColor(batch.status)}>{batch.status}</Badge></TableCell>
                  <TableCell>{gapCount > 0 ? <Badge appearance="filled" color="danger">{gapCount}段未闭环</Badge> : <span className="muted">无</span>}</TableCell>
                  <TableCell>V{batch.version}</TableCell>
                </TableRow>
              })}
            </TableBody>
          </Table>
          {selected && <div className="gap-panel">
            <div className="gap-head"><h3>监控断档判定（按当时频率版本）</h3>
              <Button size="small" appearance="primary" disabled={!selectedGaps.some((g) => g.status === '未确认')}
                onClick={() => dispatch(confirmGapDeviations({ keys: selectedGaps.filter((g) => g.status === '未确认').map((g) => g.key) }))}>
                登记断档偏差（{selectedGaps.filter((g) => g.status === '未确认').length}）
              </Button>
            </div>
            {selectedGaps.length === 0 && <p className="muted">未发现相邻读数超过当时频率的断档。</p>}
            {selectedGaps.map((gap) => {
              const step = state.processSteps.find((s) => s.id === gap.stepId)
              const linked = state.deviations.find((d) => d.id === gap.deviationId)
              return <div key={gap.id} className={`gap-card gap-${gap.status}`}>
                <div className="gap-card-head">
                  <strong>{step?.name} · {step?.controlPoint}</strong>
                  <Badge color={gapColor[gap.status]} appearance="tint">{gap.status}</Badge>
                </div>
                <div className="gap-segments">
                  {gap.segments.map((seg, i) => <span key={i}>
                    {formatInterval(seg.intervalMinutes)}适用段 {minute(seg.from)}–{minute(seg.to)}，超时{seg.overdueMinutes}分钟
                  </span>)}
                </div>
                <small>
                  {minute(gap.startAt)} 起，{gap.endKind === '改频时刻' ? '结束于改频时刻' : `至下一读数 ${minute(gap.endAt)}`}；
                  判定修订 V{gap.revision}
                  {linked && `；偏差 ${linked.id}（${linked.status}）`}
                  {gap.resolvedAt && '；已闭环'}
                </small>
              </div>
            })}
          </div>}
        </div>
        {selected && <aside className="record-panel">
          <div className="record-title"><div><span>{selected.id} · {selected.line}</span><h2>{selected.product}</h2></div><Badge color={statusColor(selected.status)}>{selected.status}</Badge></div>
          <dl><div><dt>生产数量</dt><dd>{selected.quantity.toLocaleString()} 件</dd></div><div><dt>隔离范围</dt><dd>{selected.isolationScope}</dd></div><div><dt>关联偏差</dt><dd>{selectedDeviations.length} 项</dd></div></dl>

          <h3>监测读数 <Button size="small" appearance="subtle" onClick={() => setAdding((v) => !v)}>{adding ? '取消' : '录入/补录'}</Button></h3>
          <div className="monitoring-list">
            {selected.monitoring.slice().sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).map((item) => {
              const step = state.processSteps.find((s) => s.id === item.stepId)
              const governing = versionAt(state.frequencyVersions.filter((v) => v.stepId === item.stepId), item.recordedAt)
              const inLimit = step ? evaluateValue(step, item.value) : true
              return <div key={item.id}>
                <span>{step?.controlPoint}</span>
                <strong className={inLimit ? '' : 'value-out'}>{item.value} {item.unit} {!inLimit && '超限'}</strong>
                <small>
                  读数 {minute(item.recordedAt)} · {item.operator}
                  {item.backfilled && <Badge size="small" color="warning">补录</Badge>}
                  {item.backfilled && <> · 录入 {minute(item.enteredAt)}</>}
                  {!governing && <Badge size="small" color="danger">缺频率版本</Badge>}
                </small>
              </div>
            })}
          </div>
          {adding && <div className="add-reading">
            <Field label="控制点">
              <Dropdown value={readingForm.stepId} selectedOptions={[readingForm.stepId]} onOptionSelect={(_, data) => setReadingForm({ ...readingForm, stepId: data.optionValue ?? '' })}>
                {state.processSteps.map((s) => <Option key={s.id} value={s.id}>{s.name}</Option>)}
              </Dropdown>
            </Field>
            <Field label="读数值"><Input type="number" value={readingForm.value} onChange={(_, data) => setReadingForm({ ...readingForm, value: data.value })} /></Field>
            <Field label="读数时刻"><Input type="datetime-local" value={readingForm.recordedAt} onChange={(_, data) => setReadingForm({ ...readingForm, recordedAt: data.value })} /></Field>
            <Field label="录入方式">
              <Dropdown value={readingForm.entryMode === 'backfill' ? '补录（另记录入时间）' : '正常录入'} selectedOptions={[readingForm.entryMode]} onOptionSelect={(_, data) => setReadingForm({ ...readingForm, entryMode: data.optionValue as 'timely' | 'backfill' })}>
                <Option value="timely">正常录入</Option>
                <Option value="backfill">补录（另记录入时间）</Option>
              </Dropdown>
            </Field>
            <Field label="记录人"><Input value={readingForm.operator} onChange={(_, data) => setReadingForm({ ...readingForm, operator: data.value })} placeholder="当班操作工" /></Field>
            <Button size="small" appearance="primary" onClick={submitReading}>追加读数（不改原有读数）</Button>
          </div>}

          <h3>放行结论</h3>
          {evaluation && (evaluation.ready
            ? <p className="ready-text">频率依据、监测证据与偏差处置均已闭环，可进入放行流程。</p>
            : <ul className="block-list">{evaluation.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul>)}

          <div className="record-actions">
            <Button appearance="secondary" disabled={!evaluation?.ready} onClick={() => dispatch(updateBatchStatus({ id: selected.id, status: '可放行' }))}>提交放行复核</Button>
            <Button appearance="primary" disabled={selected.status !== '可放行'} onClick={() => dispatch(updateBatchStatus({ id: selected.id, status: '已放行' }))}>签字放行</Button>
          </div>
          {!evaluation?.ready && <p className="validation-text">断档批次先冻结：偏差复核通过且补录后有合格读数，批次才回到放行流程。</p>}
        </aside>}
      </div>
    </section>
  )
}
