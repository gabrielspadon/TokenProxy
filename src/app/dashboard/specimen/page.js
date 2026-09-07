import { notFound } from 'next/navigation';
import ComponentSpecimen from './ComponentSpecimen';

export const dynamic = 'force-dynamic';

export default function SpecimenPage() {
  if (process.env.NODE_ENV !== 'development' && process.env.TOKENPROXY_PREVIEW_ISOLATED !== '1') notFound();
  return <ComponentSpecimen />;
}
