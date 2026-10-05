import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react'
import { seedBatches } from '../data/seed'
import { evaluateRelease } from './frequency'
import type { Batch, Deviation, FrequencyVersion, GapRecord, ProcessStep, ReleaseEvaluation } from '../types'

export const haccpApi = createApi({
  reducerPath: 'haccpApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    loadBatchSnapshot: builder.query<Batch[], void>({
      queryFn: async () => ({ data: structuredClone(seedBatches) })
    }),
    /** 放行结论：把控制矩阵频率版本、批次监测断档、偏差处置接到同一份频率依据上 */
    checkReleaseReadiness: builder.query<
      ReleaseEvaluation,
      { batch: Batch; batches: Batch[]; deviations: Deviation[]; frequencyVersions: FrequencyVersion[]; steps: ProcessStep[]; gaps: GapRecord[] }
    >({
      queryFn: async (arg) => ({
        data: evaluateRelease(arg.batch, arg.batches, arg.deviations, arg.frequencyVersions, arg.steps, arg.gaps)
      })
    })
  })
})

export const { useLoadBatchSnapshotQuery, useCheckReleaseReadinessQuery } = haccpApi
