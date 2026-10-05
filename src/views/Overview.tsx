import { useMemo, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Badge, Button, Dropdown, Field, Input, Option, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from '@fluentui/react-components'
import type { AppDispatch, RootState } from '../store'
import { addReading, nowLocal, setBatchFilter, setBatchStatus, setSelectedBatch, updateBatchStatus } from '../store/haccpSlice'
import type { BatchStatus } from '../types'
import { useLoadBatchSnapshotQuery } from '../services/api'
import { evaluateBatchRelease, isOutOfLimit } from '../services/frequencyEngine'

const statuses: Array<BatchStatus | '全部'> = ['全部', '生产中', '待复核', '可放行', '隔离中', '已放行', '已报废']
const statusColor = (status: BatchStatus) => status === '隔离中' || status === '已报废' ? 'danger' : status === '已放行' ? 'success' : status === '可放行' ? 'important' : 'warning'
const fmt = (t: string) => t.replace('T', ' ').slice(0, 16)

export function Overview() {
  const dispatch = useDispatch<AppDispatch>()
  const state = useSelector((root: RootState) => root.haccp)
  const { isFetching } = useLoadBatchSnapshotQuery()
  const rows = useMemo(() => state.batches.filter((batch) => {
    const text = `${batch.id} ${batch.product} ${batch.line}`.toLowerCase()
    return (!state.batchFilter || text.includes(state.batchFilter.toLowerCase())) && (state.batchStatus === '全部' || batch.status === state.batchStatus)
  }), [state.batches, state.batchFilter, state.batchStatus])
  const selected = state.batches.find((item) => item.id === state.selectedBatchId) ?? rows[0]
  const selectedDeviations = state.deviations.filter((item) => item.batchId === selected?.id)
  const evaluation = useMemo(
    () => (selected ? evaluateBatchRelease(selected, state.processSteps, state.deviations) : null),
    [selected, state.processSteps, state.deviations],
  )

  const [showReading, setShowReading] = useState(false)
  const [form, setForm] = useState({ stepId: state.processSteps[0]?.id ?? '', value: '', recordedAt: nowLocal().slice(0, 16), enteredAt: '', operator: '当班操作员' })
  const openForm = () => {
    setForm({ stepId: state.processSteps[0]?.id ?? '', value: '', recordedAt: nowLocal().slice(0, 16), enteredAt: '', operator: '当班操作员' })
    setShowReading(true)
  }
  const submitReading = () => {
    if (!selected || !form.value) return
    dispatch(addReading({
      batchId: selected.id, stepId: form.stepId, value: Number(form.value),
      recordedAt: `${form.recordedAt}:00`, enteredAt: form.enteredAt ? `${form.enteredAt}:00` : undefined, operator: form.operator,
    }))
    setShowReading(false)
  }

  return (
    <section className="page">
      <header className="page-head"><div><p>质量运营中心 / 批次控制</p><h1>生产批次与放行 · 频率断档联动</h1></div><span className="sync-state">{isFetching ? '正在同步' : '批次快照已加载'}</span></header>
      <div className="metrics">
        <article><span>今日批次</span><strong>{state.batches.length}</strong><small>覆盖2条生产线</small></article>
        <article><span>冻结批次</span><strong>{state.batches.filter((item) => item.status === '隔离中').length}</strong><small>断档/偏差自动冻结放行</small></article>
        <article><span>未关闭偏差</span><strong>{state.deviations.filter((item) => item.status !== '已关闭' && item.status !== '已撤销').length}</strong><small>需调查或复核</small></article>
        <article><span>缺频率版本窗口</span><strong>{state.batches.reduce((n, b) => n + evaluateBatchRelease(b, state.processSteps, state.deviations).gaps.filter((g) => g.missingVersion).length, 0)}</strong><small>先回填才能判定</small></article>
      </div>
      <div className="toolbar">
        <Input value={state.batchFilter} onChange={(_, data) => dispatch(setBatchFilter(data.value))} placeholder="搜索批次、产品、产线" />
        <Dropdown value={state.batchStatus} selectedOptions={[state.batchStatus]} onOptionSelect={(_, data) => dispatch(setBatchStatus(data.optionValue as BatchStatus | '全部'))}>
          {statuses.map((status) => <Option key={status} value={status}>{status}</Option>)}
        </Dropdown>
        <span>点击批次查看监测频率、断档区间与放行结论</span>
      </div>
      <div className="split-layout">
        <div className="table-panel">
          <Table size="small" aria-label="生产批次">
            <TableHeader><TableRow><TableHeaderCell>批次</TableHeaderCell><TableHeaderCell>产品</TableHeaderCell><TableHeaderCell>产线</TableHeaderCell><TableHeaderCell>状态</TableHeaderCell><TableHeaderCell>版本</TableHeaderCell></TableRow></TableHeader>
            <TableBody>
              {rows.map((batch) => {
                const ev = evaluateBatchRelease(batch, state.processSteps, state.deviations)
                return <TableRow key={batch.id} onClick={() => dispatch(setSelectedBatch(batch.id))} className={batch.id === selected?.id ? 'selected-row' : ''}>
                  <TableCell>{batch.id}</TableCell><TableCell>{batch.product}</TableCell><TableCell>{batch.line}</TableCell>
                  <TableCell><Badge appearance="tint" color={statusColor(batch.status)}>{batch.status}</Badge>{ev.missingVersion && <Badge appearance="outline" color="important">待回填</Badge>}</TableCell>
                  <TableCell>V{batch.version}</TableCell>
                </TableRow>
              })}
            </TableBody>
          </Table>
        </div>
        {selected && evaluation && <aside className="record-panel">
          <div className="record-title"><div><span>{selected.id} · {selected.line}</span><h2>{selected.product}</h2></div><Badge color={statusColor(selected.status)}>{selected.status}</Badge></div>
          <dl>
            <div><dt>生产数量</dt><dd>{selected.quantity.toLocaleString()} 件</dd></div>
            <div><dt>隔离范围</dt><dd>{selected.isolationScope}</dd></div>
            <div><dt>关联偏差</dt><dd>{selectedDeviations.filter((d) => d.status !== '已撤销').length} 项（已撤销 {selectedDeviations.filter((d) => d.status === '已撤销').length}）</dd></div>
          </dl>

          <h3>监控断档判定 <small>（相邻读数间隔 &gt; 当时生效频率）</small></h3>
          {evaluation.gaps.length === 0 && <p className="hint-text">无断档：各控制点相邻读数均未超过当时生效频率。</p>}
          <div className="gap-list">
            {evaluation.gaps.map((gap) => {
              const step = state.processSteps.find((s) => s.id === gap.stepId)
              const dev = state.deviations.find((d) => d.id === gap.deviationId)
              return <div key={`${gap.stepId}-${gap.from}-${gap.to}`} className={gap.missingVersion ? 'gap-missing' : 'gap'}>
                <div><strong>{step?.name}</strong>
                  {gap.missingVersion
                    ? <Badge color="important">缺频率版本</Badge>
                    : <Badge color="danger">断档{Math.round(gap.gapMinutes)}分钟</Badge>}
                </div>
                <small>{fmt(gap.from)} → {fmt(gap.to)}</small>
                <small>判定依据：{gap.missingVersion ? '升级前历史数据无生效频率，先回填再判定' : `「${gap.basisVersion?.label}」（${gap.basisVersion?.effectiveFrom.slice(0, 16)} 生效）`}</small>
                {dev && <small>偏差 {dev.id} · {dev.status}{dev.gapConfirmed ? ' · 判定已确认固定' : ''}{dev.status === '已撤销' ? ` · ${dev.revokedReason}` : ''}</small>}
              </div>
            })}
          </div>

          <h3>监测读数 <small>（原始读数只读；补录另显示录入时间）</small></h3>
          <div className="monitoring-list">{[...selected.monitoring].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)).map((item) => {
            const step = state.processSteps.find((s) => s.id === item.stepId)
            const out = step ? isOutOfLimit(item.value, step.numericLimit) : false
            return <div key={item.id} className={out ? 'reading-breach' : ''}>
              <span>{step?.controlPoint}{out && <Badge color="danger" appearance="tint">超限</Badge>}{item.entryType === '补录' && <Badge appearance="outline" color="important">补录</Badge>}</span>
              <strong>{item.value} {item.unit}</strong>
              <small>{item.operator} · 监测 {fmt(item.recordedAt)}{item.entryType === '补录' ? ` · 录入 ${fmt(item.enteredAt)}` : ''}</small>
            </div>
          })}</div>
          <div className="record-actions"><Button appearance="subtle" onClick={openForm}>录入/补录读数</Button></div>

          {showReading && <div className="inline-form">
            <Field label="控制点"><select value={form.stepId} onChange={(e) => setForm({ ...form, stepId: e.target.value })}>{state.processSteps.map((s) => <option key={s.id} value={s.id}>{s.name}（{s.controlPoint}）</option>)}</select></Field>
            <Field label="读数"><Input type="number" value={form.value} onChange={(_, d) => setForm({ ...form, value: d.value })} /></Field>
            <Field label="监测时刻"><Input type="datetime-local" value={form.recordedAt} onChange={(_, d) => setForm({ ...form, recordedAt: d.value })} /></Field>
            <Field label="录入时刻（留空=现在；晚于监测时刻即为补录，原始读数不改）"><Input type="datetime-local" value={form.enteredAt} onChange={(_, d) => setForm({ ...form, enteredAt: d.value })} /></Field>
            <Field label="操作人"><Input value={form.operator} onChange={(_, d) => setForm({ ...form, operator: d.value })} /></Field>
            <div className="record-actions"><Button onClick={() => setShowReading(false)}>取消</Button><Button appearance="primary" disabled={!form.value} onClick={submitReading}>保存并重算断档</Button></div>
          </div>}

          <h3>放行结论</h3>
          <div className={`gate ${evaluation.releasable ? 'gate-ok' : 'gate-blocked'}`}>
            <strong>{evaluation.releasable ? '满足放行依据，可提交放行复核' : '冻结/阻断放行'}</strong>
            {evaluation.reasons.length === 0
              ? <small>频率版本齐备、无未关闭偏差、断档后已有合格读数。</small>
              : <ul>{evaluation.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
          </div>
          <div className="record-actions">
            <Button appearance="secondary" disabled={!evaluation.releasable} onClick={() => dispatch(updateBatchStatus({ id: selected.id, status: '可放行' }))}>提交放行复核</Button>
            <Button appearance="primary" disabled={selected.status !== '可放行'} onClick={() => dispatch(updateBatchStatus({ id: selected.id, status: '已放行' }))}>签字放行</Button>
          </div>
        </aside>}
      </div>
    </section>
  )
}
