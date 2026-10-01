'use strict';

/* ============================================================
   QuizController
   Single Source of Truth for all app state.
   UI render functions read from this and call its methods to
   mutate state. Nothing outside this class touches `this.data`
   directly except through its methods.
   ============================================================ */
/* Fisher-Yates shuffle, in place; returns the same array so calls can chain. */
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* Learn mode tuning knobs */
const LEARN_CHOICE_COUNT = 4; // 1 correct answer + 3 distractors
const LEARN_FR_TARGET = 2;    // correct written answers needed to master a card

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
    this.studyMode = 'flashcards'; // 'flashcards' | 'learn'

    // Learn mode state (multiple choice -> written, inside the Study tab)
    this.learnQueue = [];      // [{ cardId, stage: 'mcq' | 'fr', frCorrect }]
    this.learnChoices = null;  // answer strings for the current MCQ prompt
    this.learnPromptKey = null; // '<cardId>:<stage>' the prompt was built for
    this.learnFeedback = null; // frozen snapshot of the answer just submitted
    this.learnTotal = 0;
    this.learnMastered = 0;
    this.learnAsked = 0;
    this.learnCorrect = 0;
    this.learnStarted = false;
    this.learnFinished = false;

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

  getCardById(id) {
    return this.data.cards.find(c => c.id === id) || null;
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
    // the learn deck is built from the filtered set, so it no longer applies
    this.resetLearnSession();
  }

  setStudyMode(mode) {
    this.studyMode = mode;
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

  /* ---------------- Learn mode helpers ----------------
     Every card enters the deck as a multiple-choice question. Answering a
     card correctly promotes it to a written (free response) question and
     drops it back into the deck at a random spot; a written answer has to
     land correctly LEARN_FR_TARGET times before the card is mastered and
     leaves the deck. Any miss sends the card back as multiple choice.
     ------------------------------------------------------------------- */

  startLearnSession() {
    const cards = this.getStudyCards();
    this.learnQueue = shuffleInPlace(
      cards.map(c => ({ cardId: c.id, stage: 'mcq', frCorrect: 0 }))
    );
    this.learnTotal = this.learnQueue.length;
    this.learnMastered = 0;
    this.learnAsked = 0;
    this.learnCorrect = 0;
    this.learnFeedback = null;
    this.learnStarted = this.learnTotal > 0;
    this.learnFinished = false;
    this.prepareLearnPrompt();
  }

  resetLearnSession() {
    this.learnQueue = [];
    this.learnChoices = null;
    this.learnPromptKey = null;
    this.learnFeedback = null;
    this.learnTotal = 0;
    this.learnMastered = 0;
    this.learnAsked = 0;
    this.learnCorrect = 0;
    this.learnStarted = false;
    this.learnFinished = false;
  }

  getCurrentLearnItem() {
    // drop queued items whose card was deleted in the Editor mid-session
    while (this.learnQueue.length && !this.getCardById(this.learnQueue[0].cardId)) {
      this.learnQueue.shift();
      this.learnTotal = Math.max(this.learnMastered, this.learnTotal - 1);
    }
    return this.learnQueue[0] || null;
  }

  prepareLearnPrompt() {
    const item = this.getCurrentLearnItem();
    if (!item) {
      this.learnChoices = null;
      this.learnPromptKey = null;
      if (this.learnStarted) this.learnFinished = true;
      return;
    }
    this.learnChoices = item.stage === 'mcq' ? this.buildLearnChoices(item.cardId) : null;
    this.learnPromptKey = `${item.cardId}:${item.stage}`;
  }

  // True when the cached prompt no longer matches the head of the queue,
  // e.g. the card was deleted in the Editor mid-session.
  isLearnPromptStale() {
    const item = this.getCurrentLearnItem();
    return !item || this.learnPromptKey !== `${item.cardId}:${item.stage}`;
  }

  // Correct answer plus up to LEARN_CHOICE_COUNT - 1 distinct distractors
  buildLearnChoices(cardId) {
    const card = this.getCardById(cardId);
    if (!card) return null;

    const normalize = s => s.trim().toLowerCase();
    const seen = new Set([normalize(card.answer)]);
    const pool = [];

    const collect = cards => cards.forEach(c => {
      const text = (c.answer || '').trim();
      if (c.id === cardId || !text || seen.has(normalize(text))) return;
      seen.add(normalize(text));
      pool.push(text);
    });

    collect(this.getStudyCards());
    // a small starred-only deck may not hold enough distractors on its own
    if (pool.length < LEARN_CHOICE_COUNT - 1) collect(this.data.cards);

    shuffleInPlace(pool);
    return shuffleInPlace([card.answer, ...pool.slice(0, LEARN_CHOICE_COUNT - 1)]);
  }

  // Put a card back somewhere random, but never as the very next prompt
  requeueLearnItem(item) {
    const earliest = Math.min(2, this.learnQueue.length);
    const span = this.learnQueue.length - earliest + 1;
    this.learnQueue.splice(earliest + Math.floor(Math.random() * span), 0, item);
  }

  submitLearnAnswer(userAnswer) {
    if (this.learnFeedback) return null; // feedback is on screen; ignore extra input
    const item = this.getCurrentLearnItem();
    if (!item) return null;
    const card = this.getCardById(item.cardId);
    if (!card) return null;

    const normalize = s => (s || '').trim().toLowerCase();
    const isCorrect = normalize(userAnswer) === normalize(card.answer);
    const stage = item.stage;
    const choices = this.learnChoices;

    this.learnAsked++;
    if (isCorrect) this.learnCorrect++;

    this.learnQueue.shift();

    let mastered = false;
    if (stage === 'mcq') {
      if (isCorrect) item.stage = 'fr'; // promote: same card, now written
      this.requeueLearnItem(item);
    } else if (isCorrect) {
      item.frCorrect++;
      if (item.frCorrect >= LEARN_FR_TARGET) {
        mastered = true;
        this.learnMastered++;
      } else {
        this.requeueLearnItem(item);
      }
    } else {
      item.stage = 'mcq'; // demote back to multiple choice
      item.frCorrect = 0;
      this.requeueLearnItem(item);
    }

    // freeze what was asked so the feedback screen keeps showing it
    this.learnFeedback = {
      stage,
      choices,
      question: card.question,
      correctAnswer: card.answer,
      userAnswer: (userAnswer || '').trim(),
      isCorrect,
      mastered,
      frCorrect: item.frCorrect
    };
    return this.learnFeedback;
  }

  advanceLearn() {
    if (!this.learnFeedback) return;
    this.learnFeedback = null;
    this.prepareLearnPrompt();
  }

  getLearnAccuracy() {
    return this.learnAsked === 0
      ? 0
      : Math.round((this.learnCorrect / this.learnAsked) * 100);
  }

  /* ---------------- Quiz mode helpers ---------------- */

  startQuiz() {
    this.quizQueue = shuffleInPlace([...this.data.cards]);
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

    this.quizQueue = shuffleInPlace(missedCards);
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
    this.studyMode = 'flashcards';
    this.resetLearnSession();
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
  document.getElementById('deckTitle').textContent = controller.data.deckName || 'Flashcard Manager';

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

  const isLearn = controller.studyMode === 'learn';
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === controller.studyMode);
  });
  document.getElementById('studyFlashcardsPane').style.display = isLearn ? 'none' : '';
  document.getElementById('studyLearnPane').style.display = isLearn ? '' : 'none';

  if (isLearn) renderLearn();
  else renderFlashcards();
}

function renderFlashcards() {
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

/* ---------------- Learn sub-mode (multiple choice -> written) ---------------- */

function renderLearn() {
  const questionEl = document.getElementById('learnQuestion');
  const choicesEl = document.getElementById('learnChoices');
  const formEl = document.getElementById('learnForm');
  const inputEl = document.getElementById('learnAnswerInput');
  const feedbackEl = document.getElementById('learnFeedback');
  const continueBtn = document.getElementById('learnContinueBtn');
  const badgeEl = document.getElementById('learnStageBadge');
  const progressEl = document.getElementById('studyProgress');

  // reset the parts that are rebuilt from scratch every render
  choicesEl.innerHTML = '';
  feedbackEl.textContent = '';
  feedbackEl.className = 'feedback';
  formEl.style.display = 'none';
  continueBtn.style.display = 'none';
  badgeEl.textContent = '';
  badgeEl.className = 'stage-badge';

  if (!controller.learnStarted) {
    const cards = controller.getStudyCards();
    questionEl.textContent = cards.length === 0
      ? (controller.filterStarred
          ? 'No starred cards yet.'
          : 'No cards to learn — add some in the Editor.')
      : 'Press "Start / Restart Learn" to begin.';
    progressEl.textContent = '';
    return;
  }

  // the deck can shift under us if cards are deleted while a session runs
  if (!controller.learnFeedback && controller.isLearnPromptStale()) {
    controller.prepareLearnPrompt();
  }

  progressEl.textContent = `Mastered ${controller.learnMastered} of ${controller.learnTotal} · `
    + `${controller.learnQueue.length} in deck · Accuracy ${controller.getLearnAccuracy()}%`;

  if (controller.learnFinished) {
    questionEl.textContent = `Session complete! You mastered all ${controller.learnTotal} card(s).`;
    feedbackEl.textContent = `${controller.learnCorrect} of ${controller.learnAsked} answers correct `
      + `(${controller.getLearnAccuracy()}%).`;
    feedbackEl.className = 'feedback correct';
    return;
  }

  const fb = controller.learnFeedback;
  const stage = fb ? fb.stage : controller.getCurrentLearnItem().stage;

  badgeEl.textContent = stage === 'mcq' ? 'Multiple Choice' : 'Written Answer';
  badgeEl.classList.add(stage === 'mcq' ? 'stage-mcq' : 'stage-fr');

  if (fb) {
    questionEl.textContent = fb.question;
    if (fb.stage === 'mcq') renderLearnChoices(choicesEl, fb.choices, fb);
    renderLearnFeedback(feedbackEl, fb);
    continueBtn.style.display = '';
    continueBtn.focus();
    return;
  }

  const item = controller.getCurrentLearnItem();
  const card = controller.getCardById(item.cardId);
  questionEl.textContent = card.question;

  if (stage === 'mcq') {
    renderLearnChoices(choicesEl, controller.learnChoices, null);
  } else {
    formEl.style.display = '';
    inputEl.disabled = false;
    inputEl.value = '';
    inputEl.focus();
  }
}

function renderLearnChoices(container, choices, feedback) {
  if (!choices) return;

  const normalize = s => (s || '').trim().toLowerCase();

  choices.forEach((choice, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'choice-btn';

    const key = document.createElement('span');
    key.className = 'choice-key';
    key.textContent = i + 1;
    const text = document.createElement('span');
    text.textContent = choice;
    btn.append(key, text);

    if (feedback) {
      btn.disabled = true;
      if (normalize(choice) === normalize(feedback.correctAnswer)) {
        btn.classList.add('choice-correct');
      } else if (normalize(choice) === normalize(feedback.userAnswer)) {
        btn.classList.add('choice-wrong');
      }
    } else {
      btn.addEventListener('click', () => submitLearnAnswer(choice));
    }

    container.appendChild(btn);
  });
}

function renderLearnFeedback(feedbackEl, fb) {
  if (fb.isCorrect) {
    feedbackEl.className = 'feedback correct';
    if (fb.mastered) {
      feedbackEl.textContent = 'Correct — card mastered!';
    } else if (fb.stage === 'mcq') {
      feedbackEl.textContent = 'Correct! This one comes back as a written question.';
    } else {
      feedbackEl.textContent = `Correct! ${LEARN_FR_TARGET - fb.frCorrect} more written answer(s) to master it.`;
    }
  } else {
    feedbackEl.className = 'feedback incorrect';
    feedbackEl.textContent = `Incorrect. Correct answer: ${fb.correctAnswer}`;
  }
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
  btn.addEventListener('click', () => {
    cancelLearnAdvance();
    setActiveView(btn.dataset.view);
  });
});

// --- Editor: rename deck ---
document.getElementById('deckNameForm').addEventListener('submit', e => {
  e.preventDefault();
  const formData = new FormData(e.target);
  const name = formData.get('deckName').trim();
  if (name) controller.setDeckName(name);
  e.target.reset();
  updateUI();
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
  cancelLearnAdvance();
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

// --- Study: flashcards / learn sub-mode switch ---
document.querySelectorAll('#studyModeSwitch .mode-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    cancelLearnAdvance();
    controller.setStudyMode(btn.dataset.mode);
    updateUI();
  });
});

/* --- Study: learn mode ---
   A correct answer auto-advances after a beat; a miss waits on Continue so
   the correct answer stays readable. */

const LEARN_ADVANCE_DELAY = 850;
let learnAdvanceTimer = null;

function cancelLearnAdvance() {
  clearTimeout(learnAdvanceTimer);
  learnAdvanceTimer = null;
}

function advanceLearn() {
  cancelLearnAdvance();
  controller.advanceLearn();
  updateUI();
}

function submitLearnAnswer(answer) {
  const result = controller.submitLearnAnswer(answer);
  if (!result) return;
  updateUI();
  if (result.isCorrect) {
    learnAdvanceTimer = setTimeout(advanceLearn, LEARN_ADVANCE_DELAY);
  }
}

document.getElementById('startLearnBtn').addEventListener('click', () => {
  cancelLearnAdvance();
  controller.startLearnSession();
  updateUI();
});

document.getElementById('learnForm').addEventListener('submit', e => {
  e.preventDefault();
  submitLearnAnswer(document.getElementById('learnAnswerInput').value);
});

document.getElementById('learnContinueBtn').addEventListener('click', advanceLearn);

// number keys pick a multiple-choice answer
document.addEventListener('keydown', e => {
  if (controller.activeView !== 'study' || controller.studyMode !== 'learn') return;
  if (controller.learnFeedback || !controller.learnChoices) return;
  if (e.target.tagName === 'INPUT' || e.ctrlKey || e.altKey || e.metaKey) return;

  const pick = Number(e.key);
  if (!Number.isInteger(pick) || pick < 1 || pick > controller.learnChoices.length) return;
  e.preventDefault();
  submitLearnAnswer(controller.learnChoices[pick - 1]);
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
      cancelLearnAdvance();
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
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  document.getElementById('themeToggleBtn').textContent = THEME_LABELS[theme];
  try {
    localStorage.setItem('flashcard-theme', theme);
  } catch (e) {
    /* localStorage may be unavailable (e.g. private browsing); ignore */
  }
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
