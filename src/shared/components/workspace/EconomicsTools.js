'use client';
import { Button, Group, Modal, ScrollArea } from '@mantine/core';
import { useRouter, useSearchParams } from 'next/navigation';
import PricingEditor from './PricingEditor';
import BudgetReservations from './BudgetReservations';

export default function EconomicsTools({children}) {
  const router=useRouter(), params=useSearchParams();
  const tool=params?.get('tool');
  const setTool=value=>{const query=new URLSearchParams(window.location.search);if(value)query.set('tool',value);else query.delete('tool');router.replace(`/dashboard/usage${query.size?`?${query}`:''}`,{scroll:false});};
  return <><Group gap="sm">{children}<Button size="sm" variant="default" onClick={()=>setTool('pricing')}>Pricing</Button><Button size="sm" variant="default" onClick={()=>setTool('budgets')}>Budget reservations</Button></Group>
    <Modal opened={tool==='pricing' || tool==='budgets'} onClose={()=>setTool(null)} title={tool==='pricing'?'Pricing':'Budget reservations'} size="xl" scrollAreaComponent={ScrollArea.Autosize}>
      {tool==='pricing'?<PricingEditor/>:tool==='budgets'?<BudgetReservations/>:null}
    </Modal></>;
}
