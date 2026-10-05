import { configureStore } from '@reduxjs/toolkit'
import haccpReducer, { reconcileOnLoad } from './haccpSlice'
import { haccpApi } from '../services/api'

export const store = configureStore({
  reducer: {
    haccp: haccpReducer,
    [haccpApi.reducerPath]: haccpApi.reducer
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(haccpApi.middleware)
})

// 启动时按当前频率版本重算一次（幂等：已存在的断档窗口不会重复登记偏差）。
store.dispatch(reconcileOnLoad())

store.subscribe(() => {
  try {
    localStorage.setItem('gsb64:haccp-platform:v2', JSON.stringify(store.getState().haccp))
  } catch {
    // 浏览器存储不可用时应用仍可使用。
  }
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
