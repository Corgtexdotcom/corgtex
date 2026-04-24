import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const GLOBALS_CSS = path.join(ROOT, 'apps/web/app/globals.css');
const APPS_WEB = path.join(ROOT, 'apps/web');

// Relative luminance and contrast calculation
function getLuminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map(c => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function getContrast(l1, l2) {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseColor(c, isDarkTheme) {
  if (!c) return null;
  c = c.trim();
  if (c.startsWith('#')) {
    let r, g, b;
    if (c.length === 4) {
      r = parseInt(c[1] + c[1], 16);
      g = parseInt(c[2] + c[2], 16);
      b = parseInt(c[3] + c[3], 16);
    } else {
      r = parseInt(c.slice(1, 3), 16);
      g = parseInt(c.slice(3, 5), 16);
      b = parseInt(c.slice(5, 7), 16);
    }
    return { r, g, b };
  }
  if (c.startsWith('rgba(')) {
    const parts = c.replace('rgba(', '').replace(')', '').split(',').map(s => s.trim());
    const r = parseInt(parts[0]);
    const g = parseInt(parts[1]);
    const b = parseInt(parts[2]);
    const a = parseFloat(parts[3]);

    const bgR = isDarkTheme ? 15 : 248; // approx background
    const bgG = isDarkTheme ? 23 : 250;
    const bgB = isDarkTheme ? 42 : 252;

    return {
      r: Math.round((1 - a) * bgR + a * r),
      g: Math.round((1 - a) * bgG + a * g),
      b: Math.round((1 - a) * bgB + a * b)
    };
  }
  if (c === 'white') return { r: 255, g: 255, b: 255 };
  if (c === 'black') return { r: 0, g: 0, b: 0 };
  if (c === 'transparent') return null; // Can't compute contrast against transparent easily
  return null;
}

function resolveVar(val, varsMap) {
  if (!val) return null;
  if (val.startsWith('var(')) {
    const v = val.replace('var(', '').replace(')', '').trim();
    return resolveVar(varsMap[v], varsMap);
  }
  return val;
}

// Extract variables
const cssContent = fs.readFileSync(GLOBALS_CSS, 'utf8');

function extractBlockVars(selector) {
  const vars = {};
  const blockRegex = new RegExp(`${selector}\\s*{([^}]*)}`, 'm');
  const match = blockRegex.exec(cssContent);
  if (match) {
    const lines = match[1].split(';');
    for (const line of lines) {
      const [key, val] = line.split(':');
      if (key && val && key.trim().startsWith('--')) {
        vars[key.trim()] = val.trim();
      }
    }
  }
  return vars;
}

const lightVars = extractBlockVars(':root');
const darkVars = { ...lightVars, ...extractBlockVars('\\.dark') };

function resolveColorString(colorStr, isDarkTheme) {
  const varsMap = isDarkTheme ? darkVars : lightVars;
  const resolved = resolveVar(colorStr, varsMap);
  return parseColor(resolved, isDarkTheme);
}

// Evaluate contrast for a pair
function evaluateContrast(fgStr, bgStr, context, isDark) {
  const fg = resolveColorString(fgStr, isDark);
  const bg = resolveColorString(bgStr, isDark);
  if (!fg || !bg) return null;

  const ratio = getContrast(getLuminance(fg.r, fg.g, fg.b), getLuminance(bg.r, bg.g, bg.b));
  
  return {
    context,
    theme: isDark ? 'dark' : 'light',
    fgStr,
    bgStr,
    ratio,
    passAA: ratio >= 4.5,
    passLarge: ratio >= 3.0
  };
}

const violations = [];
const hardcodedWarnings = [];

// Phase 2: Audit globals.css rules
const cssRuleRegex = /([^{]+)\s*{([^}]*)}/g;
let match;
while ((match = cssRuleRegex.exec(cssContent)) !== null) {
  const selector = match[1].trim();
  const ruleBody = match[2];
  
  if (selector.startsWith('@') || selector === ':root' || selector === '.dark') continue;

  const bgMatch = ruleBody.match(/(?:background|background-color)\s*:\s*([^;!]+)/);
  const fgMatch = ruleBody.match(/color\s*:\s*([^;!]+)/);
  
  // Custom Tailwind @apply parsing (bg-xxx text-xxx)
  const applyMatch = ruleBody.match(/@apply\s+([^;]+)/);
  
  let bgStr = bgMatch ? bgMatch[1].trim() : null;
  let fgStr = fgMatch ? fgMatch[1].trim() : null;

  if (applyMatch) {
      const classes = applyMatch[1].split(/\s+/);
      for (const cls of classes) {
          const cleanCls = cls.replace('!', '');
          if (cleanCls.startsWith('bg-')) {
             if (cleanCls === 'bg-text') bgStr = 'var(--text)';
             else if (cleanCls.startsWith('bg-[')) bgStr = cleanCls.replace('bg-[', '').replace(']', '');
          }
          if (cleanCls.startsWith('text-')) {
             if (cleanCls === 'text-white' || cleanCls === 'text-[white]') fgStr = 'white';
             else if (cleanCls === 'text-black' || cleanCls === 'text-[black]') fgStr = 'black';
          }
      }
  }

  if (bgStr && fgStr) {
      for (const isDark of [false, true]) {
         const res = evaluateContrast(fgStr, bgStr, `globals.css -> ${selector}`, isDark);
         if (res && !res.passAA) {
             violations.push(res);
         }
      }
      
      // Check hardcoded
      if (!bgStr.includes('var(') && !fgStr.includes('var(')) {
          hardcodedWarnings.push(`globals.css -> ${selector} uses hardcoded ${bgStr} / ${fgStr}`);
      }
  }
}


// Phase 3: Audit TSX component files
const TAILWIND_COLORS = {
    'white': 'white',
    'black': 'black',
    'red-500': '#ef4444',
    'red-700': '#b91c1c',
    'red-50': '#fef2f2',
    'red-100': '#fee2e2',
    'green-50': '#f0fdf4',
    'green-100': '#dcfce7',
    'green-500': '#22c55e',
    'green-700': '#15803d',
    'green-800': '#166534',
    'blue-50': '#eff6ff',
    'blue-100': '#dbeafe',
    'blue-700': '#1d4ed8',
    'blue-800': '#1e40af',
    'emerald-50': '#ecfdf5',
    'emerald-700': '#047857',
    'text': 'var(--text)',
    'bg': 'var(--bg)',
    'muted': 'var(--muted)',
    'accent': 'var(--accent)',
    'surface': 'var(--surface)'
};

function scanDir(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            if (!fullPath.includes('node_modules') && !fullPath.includes('.next')) {
                scanDir(fullPath);
            }
        } else if (fullPath.endsWith('.tsx')) {
            const content = fs.readFileSync(fullPath, 'utf8');
            const relativePath = path.relative(APPS_WEB, fullPath);
            
            // Check tailwind pairings
            // Example: "bg-black text-white"
            const twRegex = /(?:class|className)=["'`{]([^"'`}]*)["'`}]/g;
            let twMatch;
            while ((twMatch = twRegex.exec(content)) !== null) {
                const classes = twMatch[1].split(/\s+/);
                let bgCls = classes.find(c => c.startsWith('bg-') && !c.includes(':'));
                let fgCls = classes.find(c => c.startsWith('text-') && !c.includes(':'));
                
                if (bgCls && fgCls) {
                    const bgKey = bgCls.replace('bg-', '').replace('!', '');
                    const fgKey = fgCls.replace('text-', '').replace('!', '');
                    
                    const bgVal = bgKey.startsWith('[') ? bgKey.slice(1, -1) : TAILWIND_COLORS[bgKey];
                    const fgVal = fgKey.startsWith('[') ? fgKey.slice(1, -1) : TAILWIND_COLORS[fgKey];
                    
                    if (bgVal && fgVal) {
                        for (const isDark of [false, true]) {
                           const res = evaluateContrast(fgVal, bgVal, `${relativePath} (${bgCls} ${fgCls})`, isDark);
                           if (res && !res.passAA) violations.push(res);
                        }
                        
                        if (!bgVal.includes('var(') && !fgVal.includes('var(')) {
                            hardcodedWarnings.push(`${relativePath} uses hardcoded Tailwind classes: ${bgCls} ${fgCls}`);
                        }
                    }
                }
            }
            
            // Check inline styles
            // Example: style={{ background: "black", color: "#e2e8f0" }}
            const inlineRegex = /style=\{\{([^}]+)\}\}/g;
            let inlMatch;
            while ((inlMatch = inlineRegex.exec(content)) !== null) {
                const styleBody = inlMatch[1];
                const bgM = styleBody.match(/(?:background|backgroundColor)\s*:\s*["']([^"']+)["']/);
                const fgM = styleBody.match(/color\s*:\s*["']([^"']+)["']/);
                
                if (bgM && fgM) {
                    const bgVal = bgM[1];
                    const fgVal = fgM[1];
                    
                    for (const isDark of [false, true]) {
                        const res = evaluateContrast(fgVal, bgVal, `${relativePath} (inline styles)`, isDark);
                        if (res && !res.passAA) violations.push(res);
                    }
                    if (!bgVal.includes('var(') && !fgVal.includes('var(')) {
                        hardcodedWarnings.push(`${relativePath} uses inline hardcoded colors: bg=${bgVal}, fg=${fgVal}`);
                    }
                }
            }
        }
    }
}

scanDir(APPS_WEB);

console.log("=== CONTRAST VIOLATIONS ===");
if (violations.length === 0) {
    console.log("No violations found!");
} else {
    // Dedup violations
    const seen = new Set();
    for (const v of violations) {
        const key = `${v.context}|${v.theme}`;
        if (!seen.has(key)) {
            seen.add(key);
            console.log(`❌ [${v.theme.toUpperCase()}] ${v.context}`);
            console.log(`   FG: ${v.fgStr} | BG: ${v.bgStr}`);
            console.log(`   Ratio: ${v.ratio.toFixed(2)}:1 (Needs 4.5:1 for AA)`);
            console.log("");
        }
    }
}

console.log("\n=== HARDCODED COLOR USAGE (MAINTAINABILITY WARNINGS) ===");
const dedupWarnings = [...new Set(hardcodedWarnings)];
for (const w of dedupWarnings) {
    console.log(`⚠️ ${w}`);
}

if (violations.length > 0) {
    process.exit(1);
}
