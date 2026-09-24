// v6 musical-emphases screen. Sits between atmosphere selection (step 2)
// and hours picker (step 4). Collects one free-text field where the owner
// tells Rubin what to lean toward and what to avoid ("no electronic",
// "more R&B", "hits only", etc). Whatever they write here is threaded into
// the Gemini musical-directions prompt as a heavily-weighted signal.
//
// Visual layout matches the business-description page: animated brand
// logo + SonicBrands title + subtitle + one input-wrap + submit button.
// The brand block is cloned from mainCardTemplateHtml (captured in app.js
// when the flow starts) so the rotating SVG animation is preserved.

const HEADING_SUBTITLE = 'רובין כבר יודע מה יעשה טוב לעסק, אבל תנו לו דגשים. ' +
  'ספרו לו אם יש סגנונות שאתם מאוד אוהבים - ודברים שאתם פשוט לא סובלים';

const FIELD_LABEL = 'דגשים מוזיקליים';

const FIELD_PLACEHOLDER =
  'ממש לא מוזיקה אלקטרונית / כמה שיותר אר אן בי / שכל פלייליסט יהיה מגוון והרפתקני / רק אינסטרומנטלי / להיטים בלבד…';

// Extract a fresh copy of the brand block from the mainCard snapshot. We
// clone rather than move so navigating back to step 1 still finds its
// original brand block intact after the snapshot is re-injected.
function cloneBrandBlock(mainCardHtml) {
  const tmp = document.createElement('div');
  tmp.innerHTML = mainCardHtml || '';
  const brand = tmp.querySelector('.brand');
  return brand ? brand.cloneNode(true) : null;
}

// Runs the musical-emphases step. `initialValue` pre-fills the textarea
// when the user navigates back to this step. Resolves with the trimmed
// textarea string (may be empty — the field is optional).
export function runEmphasesStep({ initialValue = '', mainCardHtml = '' } = {}) {
  const card = document.querySelector('.screen-card');
  if (!card) throw new Error('emphases: .screen-card not found');

  // Brand block — animated logo + SonicBrands title. Same visual as step 1.
  const brand = cloneBrandBlock(mainCardHtml);

  const subtitle = document.createElement('p');
  subtitle.className = 'subtitle';
  subtitle.textContent = HEADING_SUBTITLE;

  const wrap = document.createElement('div');
  wrap.className = 'input-wrap';

  const label = document.createElement('label');
  label.className = 'input-label';
  label.setAttribute('for', 'musicalEmphases');
  label.textContent = FIELD_LABEL;
  wrap.append(label);

  const textarea = document.createElement('textarea');
  textarea.className = 'input-textarea';
  textarea.id = 'musicalEmphases';
  textarea.placeholder = FIELD_PLACEHOLDER;
  textarea.maxLength = 500;
  if (initialValue) textarea.value = initialValue;
  wrap.append(textarea);

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-primary btn-block';
  submitBtn.type = 'button';
  submitBtn.textContent = 'המשך ←';

  // Skip button — explicit escape hatch for owners who don't have strong
  // preferences. Light-blue (teal-soft from the palette) so it reads as a
  // secondary/de-emphasized action next to the primary orange "המשך".
  // Resolving with '' triggers the same downstream path as an empty field.
  const skipBtn = document.createElement('button');
  skipBtn.className = 'btn btn-block';
  skipBtn.type = 'button';
  skipBtn.textContent = 'דלג';
  skipBtn.style.background = 'var(--teal-soft)';
  skipBtn.style.color = '#0a1117';
  skipBtn.style.boxShadow = 'none';
  skipBtn.style.marginTop = '10px';

  // Gate המשך on there being real content — anything shorter than
  // MIN_LEN characters gives Gemini no useful signal. Skip stays enabled
  // as the escape hatch. Threshold matches runBusinessStep's bizDesc floor.
  const MIN_LEN = 4;
  const syncSubmitEnabled = () => {
    submitBtn.disabled = textarea.value.trim().length < MIN_LEN;
  };
  syncSubmitEnabled();
  textarea.addEventListener('input', syncSubmitEnabled);

  const children = [];
  if (brand) children.push(brand);
  children.push(subtitle, wrap, submitBtn, skipBtn);
  card.replaceChildren(...children);

  return new Promise((resolve) => {
    const finish = (value) => {
      submitBtn.disabled = true;
      skipBtn.disabled = true;
      const spinner = document.createElement('span');
      spinner.className = 'sb-spinner';
      spinner.setAttribute('aria-label', 'טוען');
      // Show the spinner on whichever button was clicked so the user sees
      // their action being processed, not the other one.
      (value ? submitBtn : skipBtn).replaceChildren(spinner);
      resolve(value);
    };
    submitBtn.addEventListener('click', () => {
      if (submitBtn.disabled) return; // guard against Enter racing the click
      finish(textarea.value.trim());
    });
    skipBtn.addEventListener('click', () => finish(''));
    // Enter (without Shift) also submits, matching the business-description
    // page's dictation-friendly Enter behavior. Shift+Enter still line-breaks.
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (textarea.value.trim().length >= MIN_LEN) {
          finish(textarea.value.trim());
        }
      }
    });
  });
}
