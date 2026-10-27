import { content } from '@/content';

const icons = ['M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zm-6 8a6 6 0 0 0 12 0M12 17v4', 'M3 5h18v11H3zM8 21h8M12 16v5', 'M5 3h9l5 5v13H5zM14 3v5h5', 'M15 7a4 4 0 1 1-3 6.6L4 21v-3h3v-3h3l1.4-1.4'];

export default function TrustPanel() {
  const trust = content.trust;
  return (
    <div className="trust-panel" role="group" aria-label={trust.title}>
      <ul>
        {trust.items.map((item, index) => (
          <li key={item.name}>
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={icons[index]} /></svg>
            <div>
              <b>{item.name}<span>{item.state}</span></b>
              <p>{item.body}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
