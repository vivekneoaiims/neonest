# NeoNEST — Neonatal Essential Support Tools

NICU digitalization suite by Dr. Vivek Kumar, LHMC New Delhi.

## Features
- **30-second TPN Calculator** — Complete parenteral nutrition with syringe compositions
- **GIR Calculator** — Glucose infusion rate calculator
- **Nutrition Audit** — 18-nutrient tracking against ESPGHAN/AAP guidelines
- **Editable Nutrition Database** — Customize EBM, formula, HMF, RDA values
- 3 themes (Light, Classic, Dark)
- PWA — installable, works offline

## Deploy to Vercel (Free, 5 minutes)

### Step 1: Create GitHub repo
1. Go to https://github.com/new
2. Name it `neonest` (or anything)
3. Create repo (public or private both work)

### Step 2: Push this code
```bash
cd neonest-pwa
git init
git add .
git commit -m "NeoNEST v1.0"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/neonest.git
git push -u origin main
```

### Step 3: Connect Vercel
1. Go to https://vercel.com → Sign in with GitHub
2. Click "Add New Project" → Import your `neonest` repo
3. Framework: **Vite** (auto-detected)
4. Click **Deploy**
5. Done! Live at `https://neonest-xxx.vercel.app`

### Step 4 (Optional): Custom domain
- In Vercel dashboard → Settings → Domains
- Add `neonest.in` or any domain you buy (~₹700/year)

## Local Development
```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # Production build in dist/
npm run preview  # Preview production build
```

## Future Updates
Just `git push` — Vercel auto-deploys. PWA service worker updates automatically.

---
© Dr. Vivek Kumar | LHMC, New Delhi | @VivekNeoAiims
