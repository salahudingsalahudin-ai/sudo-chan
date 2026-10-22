# Sudo-chan Browser QA — 22 October 2026

## Test setup

Local production build ko Playwright aur headless Google Chrome mein test kiya: desktop 1440×900, Pixel 7 emulation aur reduced-motion desktop. Browser form requests mock ki gayi; asli Supabase mein test emails save nahi kiye.

## Verified

- Teenon modes: single h1, horizontal overflow nahi, theme toggle aur reload persistence.
- Keyboard Enter se bot welcome; mood selection update.
- Empty/invalid email browser mein reject; koi POST nahi.
- Signup loading mein button disabled; success par field clear aur Done state.
- Duplicate aur server failure messages; failure ke baad retry enabled.
- Privacy page load; tested flows mein JavaScript exceptions nahi. Mocked 409/503 responses ke expected network errors alag hain.
- Follow-up: fallback eyes mouse ke saath up/down; 25 clicks par sleep aur 8 seconds baad wake.
- Stuck-detector preview ka fix typo correct karta hai; FAQ ke 5 items load aur Enter se accordion open hota hai.
- robots.txt, sitemap.xml aur Open Graph image HTTP 200.
- Fix ke baad production build pass. Pichle baseline mein 7 Vitest tests pass the.

## Bug QA-001 — Dark-mode form status text ka low contrast

**What happened:** Error, success aur loading text light-mode ke fixed dark colors use kar raha tha.

**Why it matters:** Dark background par signup ka result parhna mushkil tha.

**Steps:** Dark theme select karo, waitlist form submit karo aur mocked 503, 409 ya success response dikhao.

**Expected:** Dono themes mein status text saaf parhne layak ho.

**Actual:** Purana error color #a32222 dark surface #222a31 par takreeban 1.95:1 contrast deta tha.

**Impact:** Signup failure samajhna aur retry karna mushkil; severity medium.

**Fix:** Theme-specific error, success aur progress color variables add kiye. Dark-mode error ka computed contrast ab 8.57:1 aur success 9.32:1 hai. Light-mode error 7.48:1 aur success 5.79:1 raha. Loading ratios text opacity se pehle measure hue.

## Remaining checks

- Live Vercel deployment aur real Supabase signup/rate-limit configuration verify nahi ki.
- Real phone aur hardware-accelerated 3D performance, complete raycasting interactions aur scroll smoothness abhi pending hain. Initial WebGL screenshot mila, lekin headless rendering slow thi; functional suite WebGL-disabled fallback par chalayi.
- Scroll positions aur overflow check hue; isay visual flicker/performance pass na samjha jaye.
- Existing uncommitted SudoChanJourney.tsx changes preserve kiye. Koi commit, push ya deploy nahi kiya.

Temporary screenshots aur machine-readable results: /tmp/sudo-chan-audit/ (permanent storage nahi).
