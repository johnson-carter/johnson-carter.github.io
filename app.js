'use strict';

/* ============================================================
   QuizController
   Single Source of Truth for all app state.
   UI render functions read from this and call its methods to
   mutate state. Nothing outside this class touches `this.data`
   directly except through its methods.
   ============================================================ */
class QuizController {
  constructor() {
    this.data = {
      deckName: 'New Deck',
      cards: [

      ]
    };

    // Study mode state
    this.filterStarred = false;
    this.studyIndex = 0;
    this.isFlipped = false;

    // Quiz mode state
    this.quizQueue = [];
    this.quizIndex = 0;
    this.quizScore = 0;
    this.quizFinished = false;
    this.quizResults = []; // [{ cardId, question, userAnswer, correctAnswer, isCorrect }]

    // active view name
    this.activeView = 'editor';
  }

  /* ---------------- Deck-level mutations ---------------- */

  setDeckName(name) {
    this.data.deckName = name || this.data.deckName;
  }

  addCard(question, answer) {
    const newCard = {
      id: Date.now(),
      question,
      answer,
      starred: false
    };
    this.data.cards.push(newCard);
  }

  deleteCard(id) {
    this.data.cards = this.data.cards.filter(c => c.id !== id);
  }

  updateCardField(id, field, value) {
    const card = this.data.cards.find(c => c.id === id);
    if (card) card[field] = value;
  }

  toggleStarById(id) {
    const card = this.data.cards.find(c => c.id === id);
    if (card) card.starred = !card.starred;
  }

  /* ---------------- Study mode helpers ---------------- */

  getStudyCards() {
    return this.filterStarred
      ? this.data.cards.filter(c => c.starred)
      : this.data.cards;
  }

  toggleFilterStarred() {
    this.filterStarred = !this.filterStarred;
    this.studyIndex = 0;
    this.isFlipped = false;
  }

  studyNext() {
    const cards = this.getStudyCards();
    if (cards.length === 0) return;
    this.studyIndex = (this.studyIndex + 1) % cards.length;
    this.isFlipped = false;
  }

  studyPrev() {
    const cards = this.getStudyCards();
    if (cards.length === 0) return;
    this.studyIndex = (this.studyIndex - 1 + cards.length) % cards.length;
    this.isFlipped = false;
  }

  studyFlip() {
    this.isFlipped = !this.isFlipped;
  }

  toggleStarCurrentStudyCard() {
    const cards = this.getStudyCards();
    const card = cards[this.studyIndex];
    if (card) this.toggleStarById(card.id);
  }

  /* ---------------- Quiz mode helpers ---------------- */

  startQuiz() {
    // shuffle a copy of the cards (Fisher-Yates)
    const shuffled = [...this.data.cards];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    this.quizQueue = shuffled;
    this.quizIndex = 0;
    this.quizScore = 0;
    this.quizResults = [];
    this.quizFinished = this.quizQueue.length === 0;
  }

  getCurrentQuizCard() {
    return this.quizQueue[this.quizIndex] || null;
  }

  submitQuizAnswer(userAnswer) {
    const card = this.getCurrentQuizCard();
    if (!card) return null;

    const normalize = s => s.trim().toLowerCase();
    const isCorrect = normalize(userAnswer) === normalize(card.answer);
    if (isCorrect) this.quizScore++;

    this.quizResults.push({
      cardId: card.id,
      question: card.question,
      userAnswer: userAnswer.trim(),
      correctAnswer: card.answer,
      isCorrect
    });

    this.quizIndex++;
    if (this.quizIndex >= this.quizQueue.length) this.quizFinished = true;

    return { isCorrect, correctAnswer: card.answer };
  }

  // Build a fresh quiz queue containing only the questions missed last run
  retryMissedQuestions() {
    const missedIds = this.quizResults
      .filter(r => !r.isCorrect)
      .map(r => r.cardId);

    const missedCards = this.data.cards.filter(c => missedIds.includes(c.id));

    // shuffle the missed subset
    for (let i = missedCards.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [missedCards[i], missedCards[j]] = [missedCards[j], missedCards[i]];
    }

    this.quizQueue = missedCards;
    this.quizIndex = 0;
    this.quizScore = 0;
    this.quizResults = [];
    this.quizFinished = this.quizQueue.length === 0;
  }

  /* ---------------- File I/O ---------------- */

  loadData(jsonString) {
    const parsed = JSON.parse(jsonString);
    if (!parsed || !Array.isArray(parsed.cards)) {
      throw new Error('Invalid deck file: missing "cards" array.');
    }
    // basic normalization so malformed fields don't break the UI
    parsed.cards = parsed.cards.map(c => ({
      id: c.id ?? Date.now() + Math.random(),
      question: c.question ?? '',
      answer: c.answer ?? '',
      starred: !!c.starred
    }));
    this.data = {
      deckName: parsed.deckName || 'Untitled Deck',
      cards: parsed.cards
    };
    // reset transient state
    this.filterStarred = false;
    this.studyIndex = 0;
    this.isFlipped = false;
    this.quizQueue = [];
    this.quizIndex = 0;
    this.quizScore = 0;
    this.quizFinished = false;
    this.quizResults = [];
  }

  serialize() {
    return JSON.stringify(this.data, null, 2);
  }
}

/* ============================================================
   App / UI layer
   Pure "projection" functions: read controller state, draw DOM.
   Every user interaction calls a controller method, then
   re-renders via updateUI().
   ============================================================ */

const controller = new QuizController();

/* ---------------- View switching ---------------- */

const deckTitleInput = document.getElementById('deckTitle');
if (deckTitleInput) {
  deckTitleInput.addEventListener('change', () => {
    controller.setDeckName(deckTitleInput.value);
    updateUI();
  });
}

function setActiveView(viewName) {
  controller.activeView = viewName;

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
  document.querySelectorAll('.view').forEach(section => {
    section.classList.toggle('active', section.id === `view-${viewName}`);
  });

  updateUI();
}

function updateUI() {
  const deckTitleInput = document.getElementById('deckTitle');
  if (deckTitleInput) {
    deckTitleInput.value = controller.data.deckName || 'Flashcard Manager';
  }

  if (controller.activeView === 'editor') renderEditor();
  if (controller.activeView === 'study') renderStudy();
  if (controller.activeView === 'quiz') renderQuiz();
}

/* ---------------- Editor view ---------------- */

function renderEditor() {
  const tbody = document.getElementById('editorTableBody');
  tbody.innerHTML = '';

  controller.data.cards.forEach(card => {
    const tr = document.createElement('tr');

    // Question cell
    const qTd = document.createElement('td');
    const qInput = document.createElement('input');
    qInput.type = 'text';
    qInput.value = card.question;
    qInput.addEventListener('change', () => {
      controller.updateCardField(card.id, 'question', qInput.value);
    });
    qTd.appendChild(qInput);

    // Answer cell
    const aTd = document.createElement('td');
    const aInput = document.createElement('input');
    aInput.type = 'text';
    aInput.value = card.answer;
    aInput.addEventListener('change', () => {
      controller.updateCardField(card.id, 'answer', aInput.value);
    });
    aTd.appendChild(aInput);

    // Starred cell
    const sTd = document.createElement('td');
    const sInput = document.createElement('input');
    sInput.type = 'checkbox';
    sInput.checked = card.starred;
    sInput.addEventListener('change', () => {
      controller.updateCardField(card.id, 'starred', sInput.checked);
    });
    sTd.appendChild(sInput);

    // Delete cell
    const dTd = document.createElement('td');
    const dBtn = document.createElement('button');
    dBtn.textContent = 'Delete';
    dBtn.className = 'btn btn-danger';
    dBtn.addEventListener('click', () => {
      controller.deleteCard(card.id);
      updateUI();
    });
    dTd.appendChild(dBtn);

    tr.append(qTd, aTd, sTd, dTd);
    tbody.appendChild(tr);
  });

  if (controller.data.cards.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = 'No cards yet — add one above.';
    td.style.color = 'var(--muted)';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

/* ---------------- Study view ---------------- */

function renderStudy() {
  const filterCheckbox = document.getElementById('filterStarredCheckbox');
  filterCheckbox.checked = controller.filterStarred;

  const cards = controller.getStudyCards();
  const progressLabel = document.getElementById('studyProgress');
  const flashcardEl = document.getElementById('flashcard');
  const faceEl = document.getElementById('flashcardFace');
  const starBtn = document.getElementById('starBtn');

  if (cards.length === 0) {
    faceEl.textContent = controller.filterStarred
      ? 'No starred cards yet.'
      : 'No cards to study — add some in the Editor.';
    flashcardEl.classList.remove('starred');
    progressLabel.textContent = '';
    starBtn.disabled = true;
    return;
  }

  // clamp index in case list shrank (e.g. filter toggled or card deleted)
  if (controller.studyIndex >= cards.length) controller.studyIndex = 0;

  const card = cards[controller.studyIndex];
  faceEl.textContent = controller.isFlipped ? card.answer : card.question;
  flashcardEl.classList.toggle('starred', card.starred);
  progressLabel.textContent = `Card ${controller.studyIndex + 1} of ${cards.length}${controller.isFlipped ? ' (Answer)' : ' (Question)'}`;

  starBtn.disabled = false;
  starBtn.textContent = card.starred ? '\u2605 Starred' : '\u2606 Star';
  starBtn.classList.toggle('starred-btn', card.starred);
}

/* ---------------- Quiz view ---------------- */

function renderQuiz() {
  const questionEl = document.getElementById('quizQuestion');
  const progressEl = document.getElementById('quizProgress');
  const scoreEl = document.getElementById('quizScore');
  const feedbackEl = document.getElementById('quizFeedback');
  const answerInput = document.getElementById('quizAnswerInput');
  const quizForm = document.getElementById('quizForm');
  const resultsArea = document.getElementById('quizResultsArea');
  const finishActions = document.getElementById('quizFinishActions');
  const retryMissedBtn = document.getElementById('retryMissedBtn');

  feedbackEl.textContent = '';
  feedbackEl.className = 'feedback';

  // default state: hide results/retry UI, show the active-quiz form
  resultsArea.style.display = 'none';
  finishActions.style.display = 'none';
  quizForm.style.display = '';

  if (controller.quizQueue.length === 0) {
    questionEl.textContent = 'Press "Start / Restart Quiz" to begin.';
    progressEl.textContent = '';
    scoreEl.textContent = '';
    answerInput.value = '';
    answerInput.disabled = true;
    return;
  }

  if (controller.quizFinished) {
    questionEl.textContent = `Quiz complete! Final score: ${controller.quizScore} / ${controller.quizQueue.length}`;
    progressEl.textContent = '';
    scoreEl.textContent = '';
    answerInput.value = '';
    answerInput.disabled = true;
    quizForm.style.display = 'none';

    renderQuizResultsList();
    resultsArea.style.display = '';
    finishActions.style.display = '';

    const missedCount = controller.quizResults.filter(r => !r.isCorrect).length;
    retryMissedBtn.disabled = missedCount === 0;
    retryMissedBtn.textContent = missedCount === 0
      ? 'No missed questions'
      : `Retry Missed Questions (${missedCount})`;

    return;
  }

  const card = controller.getCurrentQuizCard();
  questionEl.textContent = card.question;
  progressEl.textContent = `Question ${controller.quizIndex + 1} of ${controller.quizQueue.length}`;
  scoreEl.textContent = `Score: ${controller.quizScore}`;
  answerInput.disabled = false;
  answerInput.value = '';
  answerInput.focus();
}

function renderQuizResultsList() {
  const resultsArea = document.getElementById('quizResultsArea');
  resultsArea.innerHTML = '';

  const heading = document.createElement('h3');
  heading.className = 'quiz-results-heading';
  heading.textContent = 'Review Answers';
  resultsArea.appendChild(heading);

  const list = document.createElement('ul');
  list.className = 'quiz-results-list';

  controller.quizResults.forEach(r => {
    const li = document.createElement('li');
    li.className = `quiz-result-row ${r.isCorrect ? 'correct-row' : 'incorrect-row'}`;

    const qDiv = document.createElement('div');
    qDiv.className = 'quiz-result-question';
    qDiv.textContent = `${r.isCorrect ? '\u2714' : '\u2718'} ${r.question}`;

    const yourDiv = document.createElement('div');
    yourDiv.className = 'quiz-result-your-answer';
    yourDiv.textContent = `Your answer: ${r.userAnswer || '(blank)'}`;

    li.appendChild(qDiv);
    li.appendChild(yourDiv);

    if (!r.isCorrect) {
      const correctDiv = document.createElement('div');
      correctDiv.className = 'quiz-result-correct-answer';
      correctDiv.textContent = `Correct answer: ${r.correctAnswer}`;
      li.appendChild(correctDiv);
    }

    list.appendChild(li);
  });

  resultsArea.appendChild(list);
}

/* ============================================================
   Event wiring
   ============================================================ */

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => setActiveView(btn.dataset.view));
});

// --- Editor: add card ---
document.getElementById('addCardForm').addEventListener('submit', e => {
  e.preventDefault();
  const formData = new FormData(e.target);
  const question = formData.get('question').trim();
  const answer = formData.get('answer').trim();
  if (!question || !answer) return;
  controller.addCard(question, answer);
  e.target.reset();
  updateUI();
});

// --- Study: filter toggle (reactive) ---
document.getElementById('filterStarredCheckbox').addEventListener('change', () => {
  controller.toggleFilterStarred();
  updateUI();
});

// --- Study: flip / star / next / prev ---
document.getElementById('flashcard').addEventListener('click', () => {
  controller.studyFlip();
  updateUI();
});
document.getElementById('flipBtn').addEventListener('click', () => {
  controller.studyFlip();
  updateUI();
});
document.getElementById('starBtn').addEventListener('click', () => {
  controller.toggleStarCurrentStudyCard();
  updateUI();
});
document.getElementById('nextBtn').addEventListener('click', () => {
  controller.studyNext();
  updateUI();
});
document.getElementById('prevBtn').addEventListener('click', () => {
  controller.studyPrev();
  updateUI();
});

// --- Quiz: start / submit ---
document.getElementById('startQuizBtn').addEventListener('click', () => {
  controller.startQuiz();
  updateUI();
});

document.getElementById('quizForm').addEventListener('submit', e => {
  e.preventDefault();
  const answerInput = document.getElementById('quizAnswerInput');
  const feedbackEl = document.getElementById('quizFeedback');

  if (controller.quizQueue.length === 0 || controller.quizFinished) return;

  const result = controller.submitQuizAnswer(answerInput.value);
  if (!result) return;

  if (result.isCorrect) {
    feedbackEl.textContent = 'Correct!';
    feedbackEl.className = 'feedback correct';
  } else {
    feedbackEl.textContent = `Incorrect. Correct answer: ${result.correctAnswer}`;
    feedbackEl.className = 'feedback incorrect';
  }

  // brief delay so the user can read feedback before the next question renders
  setTimeout(() => {
    updateUI();
  }, 900);
});

// --- Quiz: results screen actions ---
document.getElementById('retryMissedBtn').addEventListener('click', () => {
  controller.retryMissedQuestions();
  updateUI();
});

document.getElementById('retryFullBtn').addEventListener('click', () => {
  controller.startQuiz();
  updateUI();
});

// --- File I/O: load ---
document.getElementById('loadInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = evt => {
    try {
      controller.loadData(evt.target.result);
      setActiveView('editor');
    } catch (err) {
      alert('Failed to load deck: ' + err.message);
    }
  };
  reader.onerror = () => alert('Failed to read file.');
  reader.readAsText(file);

  // reset input so the same file can be re-selected later if needed
  e.target.value = '';
});

// --- File I/O: save ---
document.getElementById('saveBtn').addEventListener('click', () => {
  const json = controller.serialize();
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  const safeName = (controller.data.deckName || 'deck').replace(/[^a-z0-9_\- ]/gi, '').trim() || 'deck';
  a.download = `${safeName}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

/* ---------------- Theme toggle ---------------- */

const THEMES = ['light', 'dark', 'coffee', 'rose', 'midnight'];
const THEME_LABELS = {
  light: '🌙',
  dark: '☀️',
  coffee: '☕',
  midnight: '🌊',
  rose: '🌷'
 };

function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }

  document.getElementById('themeToggleBtn').textContent = THEME_LABELS[theme];

  try {
    localStorage.setItem('flashcard-theme', theme);
  } catch (e) {}
}

function initTheme() {
  let saved = 'light';
  try {
    saved = localStorage.getItem('flashcard-theme') || 'light';
  } catch (e) {
    /* ignore */
  }
  applyTheme(THEMES.includes(saved) ? saved : 'light');
}

document.getElementById('themeToggleBtn').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const nextIndex = (THEMES.indexOf(current) + 1) % THEMES.length;
  applyTheme(THEMES[nextIndex]);
});

initTheme();

/* ---------------- Initial render ---------------- */
updateUI();
