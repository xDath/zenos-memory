import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'zenos-memory',
    version: '0.1.0',
    phase: 'core-engine',
    timestamp: new Date().toISOString()
  });
}
