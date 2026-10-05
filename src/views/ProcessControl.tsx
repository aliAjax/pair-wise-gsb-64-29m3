import { useMemo, useState } from 'react'
import { Badge, Button, Field, Input, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Textarea } from '@fluentui/react-components'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from '../store'
import { backfillFrequency, changeFrequency, nowLocal } from '../store/haccpSlice'
import type { FrequencyVersion, ProcessStep } from '../types'
import { currentFrequency, effectiveFrequency, limitText } from '../services/frequencyEngine'

type Mode = 'change' | 'backfill'

export function ProcessControl() {
  const dispatch = useDispatch<AppDispatch>()
  const steps = useSelector((root: RootState) => root.haccp.processSteps)
  const now = nowLocal().slice(0, 16)
  const [editing, setEditing] = useState<{ step: ProcessStep; mode: Mode; effectiveFrom: string; label: string; note: string } | null>(null)

  const open = (step: ProcessStep, mode: Mode) => {
    const latest = [...step.frequencyVersions].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]
    setEditing({
      step, mode,
      effectiveFrom: mode === 'change' ? now : (latest?.effectiveFrom.slice(0, 16) ?? now),
      label: latest?.label ?? '', note: '',
    })
  }
  const save = () => {
    if (!editing) return
    const payload = { stepId: editing.step.id, effectiveFrom: editing.effectiveFrom, label: editing.label, note: editing.note }
    dispatch(editing.mode === 'change' ? changeFrequency(payload) : backfillFrequency(payload))
    setEditing(null)
  }

  const latestFor = (step: ProcessStep) => [...step.frequencyVersions].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]
  const invalidFuture = useMemo(() => editing
    ? editing.mode === 'change' && !!latestFor(editing.step) && editing.effectiveFrom < latestFor(editing.step).effectiveFrom.slice(0, 16)
    : false, [editing]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="page">
      <header className="page-head"><div><p>危害分析 / 关键控制点</p><h1>HACCP控制矩阵 · 频率版本化</h1></div></header>
      <div className="process-flow">{steps.map((step, index) => <div key={step.id}><b>{index + 1}</b><span>{step.name}</span><small>{step.equipment}</small></div>)}</div>
      <div className="table-panel">
        <Table size="small">
          <TableHeader><TableRow>
            <TableHeaderCell>步骤</TableHeaderCell><TableHeaderCell>控制点</TableHeaderCell><TableHeaderCell>关键限值</TableHeaderCell>
            <TableHeaderCell>当前监控频率</TableHeaderCell><TableHeaderCell>生效时刻</TableHeaderCell><TableHeaderCell>频率版本</TableHeaderCell><TableHeaderCell />
          </TableRow></TableHeader>
          <TableBody>{steps.map((step) => {
            const current = currentFrequency(step.frequencyVersions)
            const versions = [...step.frequencyVersions].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
            return <TableRow key={step.id}>
              <TableCell>{step.name}</TableCell>
              <TableCell>{step.controlPoint}</TableCell>
              <TableCell><strong>{limitText(step.numericLimit)}</strong></TableCell>
              <TableCell><Badge appearance="tint" color="brand">{current?.label ?? '缺版本·待回填'}</Badge></TableCell>
              <TableCell>{current ? current.effectiveFrom.replace('T', ' ').slice(0, 16) : '—'}</TableCell>
              <TableCell>{versions.length} 版</TableCell>
              <TableCell>
                <Button size="small" appearance="subtle" onClick={() => open(step, 'change')}>改频</Button>
                <Button size="small" appearance="subtle" onClick={() => open(step, 'backfill')}>回填历史</Button>
              </TableCell>
            </TableRow>
          })}</TableBody>
        </Table>
      </div>

      {steps.map((step) => <FrequencyTimeline key={step.id} step={step} />)}

      {editing && <div className="edit-panel">
        <h3>{editing.step.name} · {editing.mode === 'change' ? '变更监控频率（只影响生效时刻之后）' : '回填升级前历史频率（先回填，再判定历史窗口）'}</h3>
        <div className="edit-grid">
          <Field label={editing.mode === 'change' ? '生效时刻（不得早于当前版本）' : '历史生效时刻（可落在过去）'} validationMessage={invalidFuture ? '改频不能早于当前版本生效时刻；追溯历史请用“回填历史”' : undefined} validationState={invalidFuture ? 'error' : 'none'}>
            <Input type="datetime-local" value={editing.effectiveFrom} onChange={(_, d) => setEditing({ ...editing, effectiveFrom: d.value })} />
          </Field>
          <Field label="频率（如 每30分钟 / 每小时 / 连续记录 / 每批）">
            <Input value={editing.label} onChange={(_, d) => setEditing({ ...editing, label: d.value })} placeholder="每30分钟" />
          </Field>
          <Field label="变更/回填说明">
            <Input value={editing.note} onChange={(_, d) => setEditing({ ...editing, note: d.value })} />
          </Field>
        </div>
        <div className="record-actions">
          <Button onClick={() => setEditing(null)}>取消</Button>
          <Button appearance="primary" disabled={!editing.label.trim() || !editing.effectiveFrom || invalidFuture} onClick={save}>保存版本并触发重算</Button>
        </div>
      </div>}

      <div className="rule-band"><strong>频率依据规则</strong><span>每个控制点记录监控频率与生效时刻；改频追加新版本且只影响之后；相邻读数间隔超过当时生效频率即断档；未确认断档在改频后自动重算，已确认的判定固定不重算。</span></div>
    </section>
  )
}

function FrequencyTimeline({ step }: { step: ProcessStep }) {
  const versions = [...step.frequencyVersions].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
  const current = currentFrequency(step.frequencyVersions)
  return (
    <div className="freq-timeline">
      <header><span>{step.name}</span><small>{step.correctiveAction}</small></header>
      {versions.length === 0 && <p className="validation-text">该控制点尚无任何频率版本，历史监测数据无法判定断档，请先回填。</p>}
      <ol>{versions.map((v: FrequencyVersion, i) => <li key={v.id} className={current?.id === v.id ? 'current' : ''}>
        <div><b>{v.label}</b>{current?.id === v.id && <Badge appearance="tint" color="success">当前生效</Badge>}{i < versions.length - 1 && <Badge appearance="tint">历史版本</Badge>}</div>
        <small>{v.effectiveFrom.replace('T', ' ').slice(0, 16)} 起生效 · {v.kind === 'interval' ? `周期${v.intervalMinutes}分钟` : v.kind === 'continuous' ? '连续监测不做间隔判定' : '每批监测不做间隔判定'}{v.note ? ` · ${v.note}` : ''}</small>
      </li>)}</ol>
      <BackfillHint step={step} />
    </div>
  )
}

function BackfillHint({ step }: { step: ProcessStep }) {
  const firstVersion = [...step.frequencyVersions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0]
  const effectiveAtFirst = firstVersion ? effectiveFrequency(step.frequencyVersions, firstVersion.effectiveFrom) : null
  if (!firstVersion || effectiveAtFirst?.id !== firstVersion.id) return null
  return <p className="hint-text">最早版本自 {firstVersion.effectiveFrom.replace('T', ' ').slice(0, 16)} 生效；更早的升级前监测数据须回填对应频率后才会判定断档。</p>
}
