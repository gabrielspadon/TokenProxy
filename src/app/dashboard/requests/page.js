import { Suspense } from 'react';
import { RequestWorkbench } from '@/shared/components/request-workbench/RequestWorkbench';

export default function RequestsPage() {
  return <Suspense fallback={<p role="status">Loading request workbench…</p>}><RequestWorkbench /></Suspense>;
}
