import * as React from 'react';
import type { ToastProps } from './toast';

type ToasterToast = ToastProps & { id: string; title?: React.ReactNode; description?: React.ReactNode };

let count = 0;
const genId = () => (++count).toString();
let memState: { toasts: ToasterToast[] } = { toasts: [] };
const listeners: Array<(s: typeof memState) => void> = [];

function dispatch(action: { type: 'ADD' | 'REMOVE'; toast?: ToasterToast; id?: string }) {
  if (action.type === 'ADD' && action.toast) memState = { toasts: [action.toast, ...memState.toasts].slice(0, 5) };
  if (action.type === 'REMOVE') memState = { toasts: memState.toasts.filter(t => t.id !== action.id) };
  listeners.forEach(l => l(memState));
}

export function toast(props: Omit<ToasterToast, 'id'>) {
  const id = genId();
  const dismiss = () => { setTimeout(() => dispatch({ type: 'REMOVE', id }), 5000); };
  dispatch({ type: 'ADD', toast: { ...props, id, open: true, onOpenChange: (open) => { if (!open) dismiss(); } } });
  return { id, dismiss };
}

export function useToast() {
  const [state, setState] = React.useState(memState);
  React.useEffect(() => { listeners.push(setState); return () => { listeners.splice(listeners.indexOf(setState), 1); }; }, []);
  return { ...state, toast, dismiss: (id: string) => dispatch({ type: 'REMOVE', id }) };
}
