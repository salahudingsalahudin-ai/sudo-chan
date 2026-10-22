import { ImageResponse } from 'next/og';
import { content } from '@/content';

export const alt = content.openGraphImage.alt;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '88px',
          background: 'linear-gradient(135deg, #f5f5f7 0%, #e7f7f8 100%)',
          color: '#14151a',
          fontFamily: 'Arial, sans-serif',
        }}
      >
        <div style={{ fontSize: 24, letterSpacing: 8, color: '#087f91' }}>{content.openGraphImage.kicker}</div>
        <div style={{ marginTop: 32, fontSize: 72, fontWeight: 600, letterSpacing: -4 }}>{content.openGraphImage.titleLineOne}</div>
        <div style={{ fontSize: 72, fontWeight: 600, letterSpacing: -4 }}>{content.openGraphImage.titleLineTwo}</div>
        <div style={{ marginTop: 30, fontSize: 25, color: '#5b6069' }}>{content.openGraphImage.description}</div>
      </div>
    ),
    size,
  );
}
