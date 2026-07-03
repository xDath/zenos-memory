import { NextRequest, NextResponse } from 'next/server';
import { verifyEtlaSignature, issueEtlaToken, unauthorizedResponse } from '../../../lib/auth';

export async function POST(request: NextRequest) {
  const etlaSecret = process.env.ETLA_MASTER_SECRET;
  if (!etlaSecret) {
    return NextResponse.json({ error: 'Etla auth not configured' }, { status: 500 });
  }

  if (!verifyEtlaSignature(request, etlaSecret)) {
    return unauthorizedResponse();
  }

  const token = issueEtlaToken(etlaSecret);
  const expiresAt = Date.now() + 60 * 60 * 1000; // 1 hour

  return NextResponse.json({
    success: true,
    token,
    expires_at: new Date(expiresAt).toISOString(),
    note: 'Use this token in x-etla-token header for subsequent requests. Expires in 1 hour.'
  });
}
