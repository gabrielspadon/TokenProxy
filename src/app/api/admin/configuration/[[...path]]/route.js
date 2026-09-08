import { createConfigurationHandler } from '@/lib/admin/configurationHandler.js';
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';
const handle = createConfigurationHandler();
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
