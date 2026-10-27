# Key rotation: apni Groq aur Gemini keys badalna

Simple steps. Time: about 10 minutes. Karna kab hai: jab bhi key chat, screenshot ya kisi file mein aa jaye, ya
jab aap ko shak ho ke kisi ne dekh li. Rotate = **nayi key banao, app mein lagao, purani key delete karo.**

## Pehle ek zaroori rule

**Never paste a key in chat** (na Claude mein, na kisi dost ko, na GitHub, na screenshot mein).
Key sirf ek jagah jati hai: **Sudo-chan, Settings, Local AI, API key box.**
Agar ghalti se kahin paste ho gayi, to us key ko "leaked" samjho aur foran neeche ke steps karo.

## Step 1: Groq ki nayi key

1. Browser mein `console.groq.com` kholo, login karo.
2. **API Keys** par jao, **Create API Key** dabao, koi naam do (jaise `sudochan-2026`).
3. Key **ek hi baar** dikhti hai. Copy karo (abhi kahin save ya paste mat karo).
4. Sudo-chan kholo, **Settings, Local AI, Cloud**, provider **Groq**, key box mein **Ctrl+V**, phir **Save & Test connection**.
5. "Connected" aaye to nayi key kaam kar rahi hai.

## Step 2: Gemini ki nayi key

1. Browser mein `aistudio.google.com/apikey` kholo.
2. **Create API key** dabao (apna project chuno), key copy karo.
3. Sudo-chan mein **Settings, Local AI, Cloud**, provider **Gemini**, key box mein paste, **Save & Test connection**.
   (Gemini key save karne se chat Groq par hi rehti hai; Gemini sirf voice ke liye use hoti hai.)

## Step 3: Purani keys delete karo (yeh step skip mat karna)

Nayi key lagane se purani key khud band **nahi** hoti. Jab tak console mein delete na karo, wo kaam karti rahegi.

- Groq: `console.groq.com`, **API Keys**, purani key ke saath **Delete**.
- Gemini: `aistudio.google.com/apikey`, purani key ke saath **Delete key**.
- Azure Speech (agar use karte ho): Azure portal, apni Speech resource, **Keys and Endpoint**, **Regenerate Key 1**.

## Step 4: Check

- Sudo-chan se ek chhota sa sawal poocho. Jawab aaye to sab theek hai.
- Agar "401" ya "key invalid" aaye, to Settings mein key dobara paste karo (poori key, bina extra space ke).

## Agar sab saved keys ek saath hatani hon

**Settings, Your privacy, Remove saved keys.** Pehli click sirf poochti hai; **"Yes, remove all saved keys"** par click karne se
Groq, Gemini, Azure sab keys is computer se hat jati hain. Phir Step 1 aur 2 se nayi keys lagao.
Yeh sirf click se hota hai; awaaz se (voice) kuch delete nahi hota.
Note: file se hatane ka matlab "secure erase" nahi hai. Purani key ko console mein delete karna (Step 3) hi asli safai hai.

## Keys is computer par kaise save hoti hain (sach)

Yeh text app ke andar `describeKeyStorage()` (`src/main/key-storage.ts`) se aata hai, Settings isi ko dikhati hai.

- **Linux (aap ka laptop):** keys `~/.config/Sudo-chan/config.json` mein **base64** mein hain. Base64 **encryption nahi hai**:
  jo koi us file ko aap ke user ke taur par padh sakta hai (ya us file ka backup), wo key wapas nikal sakta hai.
  Is liye keys are **not encrypted on Linux**.
- Us file ko sirf aap padh sakte ho: file permissions `600` (sirf owner), folder `700`. App har start par purani file ki
  permissions bhi theek kar deti hai.
- **Windows / macOS:** keys Windows DPAPI / macOS Keychain se encrypt hoti hain. Agar system encryption available nahi bataye,
  to key plain (base64) file mein jati hai.
- Keys kabhi Sudo-chan ke server par nahi jati (koi server hai hi nahi); sirf aap ke chune hue provider (Groq, Gemini...) ko jati hain.
- Kabhi config file, `~/.config/Sudo-chan` folder ya backup kisi ko mat do, na cloud mein upload karo.

## Future option (abhi nahi banaya)

Linux par system keyring (libsecret, `secret-tool`) se asli encryption mil sakti hai. Abhi use nahi kiya kyunke is laptop par
Electron ka `safeStorage` keyring ko poochte waqt **hamesha ke liye atak jata hai** (verified), aur key padhne wale raste
(`getProviderKey`) synchronous hain, to ek hard timeout ke saath bhi main process ko safely bachana aur test karna abhi
sabit nahi hua. Agar banaya gaya to: `secret-tool` alag process mein, 1.5 s hard timeout aur kill, aur timeout par
chupchaap file par wapas; startup par kabhi nahi.
