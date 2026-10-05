import { configureStore } from '@reduxjs/toolkit'
import haccpReducer, { recalculateGaps } from './haccpSlice'
import { haccpApi } from '../services/api'

export const store = configureStore({
  reducer: {
    haccp: haccpReducer,
    [haccpApi.reducerPath]: haccpApi.reducer
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(haccpApi.middleware)
})

store.subscribe(() => {
  try {
    localStorage.setItem('gsb64:haccp-platform', JSON.stringify(store.getState().haccp))
  } catch {
    // The app remains usable when browser storage is unavailable.
  }
})

// 启动后以当前全部频率版本重算断档：历史回填基线随之生效（幂等，无变化不产生事件）
store.dispatch(recalculateGaps())

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
