// エクスポートされる関数とデフォルト設定をまとめたモジュール
export function createQuiz(options = {}) {
	/**
	 * @typedef {Object} DomRefs
	 * @property {HTMLElement} questionText
	 * @property {HTMLElement} hintButton
	 * @property {HTMLElement} hintText
	 * @property {HTMLElement[]} selectionButtons
	 * @property {HTMLElement} resultText
	 * @property {HTMLElement} nextButton
	 * @property {HTMLElement} quizScreen
	 * @property {HTMLElement} resultScreen
	 * @property {HTMLElement} scoreDisplay
	 * @property {HTMLElement} resultTableBody
	 * @property {HTMLElement=} restartButton
	 */

	/**
	 * @typedef {Object} ResultItem
	 * @property {string} question
	 * @property {string} correctAnswer
	 * @property {string} hint
	 * @property {string} answer
	 * @property {boolean} correct
	 * @property {boolean} hintUsed
	 */

	const defaults = {
		// words-data may be provided via dynamic import or window.wordsList.
		// Keep defaults empty here and populate during init to avoid static import problems.
		words: [],
		mode: 1,
		selection: 4,
		questionCount: 5,
		// enable verbose debugging in the browser console by passing { debug: true } to createQuiz
		debug: false,
		formUrl: "",
		entryIds: {},
		texts: {
			next: "次の問題",
			results: "結果を見る",
			correctText: "正解です！",
			incorrectPrefix: "不正解です。正解は「",
			incorrectSuffix: "」でした。",
		},
	};

	const cfg = Object.assign({}, defaults, options);

	// 正規化: cfg.words が外部データ (objects 配列や window.wordsList) になっている場合に
	// [word, meaning, hint] の配列に変換する
	function normalizeWords(raw) {
		if (!raw) return [];
		// Normalize into array-of-arrays where each element is [word, meaning, hint, POS]
		const out = [];
		if (Array.isArray(raw)) {
			for (const item of raw) {
				if (Array.isArray(item)) {
					// accept arrays of length 1..4, pad missing fields with empty string
					const w = item[0] || "";
					const m = item[1] || "";
					const h = item[2] || "";
					const p = item[3] || "";
					out.push([w, m, h, p]);
				} else if (typeof item === "object" && item !== null) {
					// two possible object shapes:
					// 1) { word: "insist", meaning:"..", hint: "..", POS: "動詞" }
					// 2) { "insist": { meaning, hint, POS } }
					if (typeof item.word === "string") {
						out.push([item.word || "", item.meaning || "", item.hint || "", item.POS || ""]);
					} else {
						const key = Object.keys(item)[0];
						const v = item[key] || {};
						out.push([key, v.meaning || "", v.hint || "", v.POS || ""]);
					}
				} else if (typeof item === "string") {
					out.push([item, "", "", ""]);
				} else {
					// unknown item type -> skip
				}
			}
			return out;
		}
		// object map like { word: { meaning, hint, POS } }
		if (typeof raw === "object") {
			for (const key of Object.keys(raw)) {
				const v = raw[key] || {};
				out.push([key, v.meaning || "", v.hint || "", v.POS || ""]);
			}
			return out;
		}
		return out;
	}

	// If user didn't pass words, but page provides window.wordsList, use it
	if (!cfg.words || (Array.isArray(cfg.words) && cfg.words.length === 0)) {
		if (
			typeof window !== "undefined" &&
			window.wordsList &&
			Array.isArray(window.wordsList)
		)
			cfg.words = window.wordsList;
	}

	cfg.words = normalizeWords(cfg.words || defaults.words);
	// improvement flags
	cfg.improvements = Object.assign(
		{ avoidSimilarDistractors: false },
		cfg.improvements || {}
	);

	// --- persistence: localStorage key and helper functions ---
	const STORAGE_KEY = "quiz_module_stats_v1";

	function loadStats() {
		if (typeof window === "undefined" || !window.localStorage) return { sessions: [], perWord: {}, highScore: 0 };
		try {
			const raw = window.localStorage.getItem(STORAGE_KEY);
			if (!raw) return { sessions: [], perWord: {}, highScore: 0 };
			return JSON.parse(raw);
		} catch (e) {
			try { window.localStorage.removeItem(STORAGE_KEY); } catch (e2) {}
			return { sessions: [], perWord: {}, highScore: 0 };
		}
	}

	function saveStats(s) {
		if (typeof window === "undefined" || !window.localStorage) return;
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
		} catch (e) {
			// Storage may be full or blocked; ignore silently
		}
	}

	function updateStatsWithSession(results, questionCount) {
		const stats = loadStats();
		const correct = results.filter((r) => r.correct).length;
		const session = { ts: Date.now(), score: correct, questionCount };
		stats.sessions = stats.sessions || [];
		stats.perWord = stats.perWord || {};
		stats.sessions.push(session);
		if (!stats.highScore || correct > stats.highScore) stats.highScore = correct;

		for (const r of results) {
			const key = r.correctAnswer || r.question || "<unknown>";
			if (!stats.perWord[key]) stats.perWord[key] = { attempts: 0, correct: 0, hintUsed: 0 };
			stats.perWord[key].attempts += 1;
			if (r.correct) stats.perWord[key].correct += 1;
			if (r.hint && r.hint.length > 0 && r.hintUsed) stats.perWord[key].hintUsed += 1;
		}

		saveStats(stats);
		return stats;
	}

	// state
	let count = 0;
	/** @type {ResultItem[]} */
	let results = [];
	let hintUsed = false;
	let currentQuestion = null;
	let usedWords = [];
	let correctAnswerIndex = -1;

	// --- indexing for performance (large word-lists) ---
	let indexBuilt = false;
	const wordIndexMap = { byPOS: Object.create(null), byLen: Object.create(null) };

	function buildIndex() {
		indexBuilt = false;
		wordIndexMap.byPOS = Object.create(null);
		wordIndexMap.byLen = Object.create(null);
		for (let i = 0; i < cfg.words.length; i++) {
			const w = cfg.words[i] || [];
			const POS = w[3] || "";
			if (POS) {
				wordIndexMap.byPOS[POS] = wordIndexMap.byPOS[POS] || [];
				wordIndexMap.byPOS[POS].push(i);
			}
			const text = (w[cfg.mode] || "") + "";
			const len = text.length || 0;
			wordIndexMap.byLen[len] = wordIndexMap.byLen[len] || [];
			wordIndexMap.byLen[len].push(i);
		}
		indexBuilt = true;
	}

	function getCandidateDistractorIndices(wordIndex) {
		if (!indexBuilt) buildIndex();
		const w = cfg.words[wordIndex] || [];
		const POS = w[3] || "";
		const candidates = new Set();
		if (POS && wordIndexMap.byPOS[POS]) {
			for (const idx of wordIndexMap.byPOS[POS]) if (idx !== wordIndex) candidates.add(idx);
		}
		// length-based fallback: gather neighbors within +/-2
		const text = (w[cfg.mode] || "") + "";
		const len = text.length || 0;
		for (let d = -2; d <= 2; d++) {
			const l = len + d;
			if (l < 0) continue;
			const arr = wordIndexMap.byLen[l];
			if (!arr) continue;
			for (const idx of arr) if (idx !== wordIndex) candidates.add(idx);
		}
		// final fallback: sample from entirety (but limit)
		if (candidates.size === 0) {
			for (let i = 0; i < cfg.words.length; i++) if (i !== wordIndex) candidates.add(i);
		}
		// convert to array and limit to a reasonable sample to keep costs bounded
		const arr = Array.from(candidates);
		if (arr.length > 200) return shuffleArray(arr).slice(0, 200);
		return arr;
	}

	// DOM refs (will be wired by init)
	/** @type {DomRefs} */
	let refs = {};

	// focus index for keyboard navigation inside module
	let focusedIndex = 0;

	// ---- UI action implementations ----

	function showHint() {
		if (!refs || !currentQuestion) return;
		hintUsed = true;
		const w = currentQuestion.word;
		const hintText =
			(w && w[2]) ||
			(typeof window !== "undefined" &&
				window.wordsMap &&
				window.wordsMap[w && w[0]] &&
				window.wordsMap[w[0]].hint) ||
			"(ヒントはありません)";
		if (refs.hintText) refs.hintText.textContent = hintText;
	}

	function selectAnswer(idx) {
		if (!refs || !currentQuestion) return;
		// disable all buttons to prevent double answers
		refs.selectionButtons.forEach((b) => {
			b.disabled = true;
			try {
				b.setAttribute("aria-pressed", "false");
			} catch (e) {}
		});
		const btn = refs.selectionButtons[idx];
		if (!btn) return;
		try {
			btn.setAttribute("aria-pressed", "true");
		} catch (e) {}
		const selectedText = btn.textContent || "";
		const correct = idx === correctAnswerIndex;

		// prepare result item
		const questionText =
			cfg.mode === 0
				? `「${currentQuestion.word[1]}」の英単語は？`
				: `「${currentQuestion.word[0]}」の意味は？`;
		const correctAnswer =
			(currentQuestion.word && currentQuestion.word[cfg.mode]) || "";
		const hintText =
			(refs.hintText && refs.hintText.textContent) ||
			(currentQuestion.word && currentQuestion.word[2]) ||
			"";

		results.push({
			question: questionText,
			correctAnswer,
			hint: hintText,
			answer: selectedText,
			correct,
			hintUsed,
		});

		if (refs.resultText)
			refs.resultText.textContent = correct
				? cfg.texts.correctText
				: `${cfg.texts.incorrectPrefix}${correctAnswer}${cfg.texts.incorrectSuffix}`;
		if (refs.nextButton) refs.nextButton.disabled = false;
	}

	// ---- words-data loader (attempt to load words-data.js if window.wordsList missing) ----

	function loadScript(src, timeout = 3000) {
		// Try dynamic import first so we can access module exports (avoid 'export' SyntaxError
		// when a file is treated as a classic script). If dynamic import fails, fall back
		// to appending a <script type="module"> tag.
		return new Promise((resolve, reject) => {
			let finished = false;
			const tid = setTimeout(() => {
				if (!finished) {
					finished = true;
					reject(new Error(`timeout loading ${src}`));
				}
			}, timeout);

			// dynamic import
			try {
				import(src)
					.then((mod) => {
						if (finished) return;
						finished = true;
						clearTimeout(tid);
						// if module provided a default export (words array), expose it as window.wordsList
						if (typeof window !== "undefined" && mod && mod.default) {
							try {
								window.wordsList = mod.default;
								// also build a wordsMap for backward compatibility
								if (!window.wordsMap || typeof window.wordsMap !== "object") {
									window.wordsMap = {};
									for (const w of mod.default) {
										if (!w) continue;
										const key = w.word || (Array.isArray(w) && w[0]);
										if (!key) continue;
										window.wordsMap[key] = {
											meaning: w.meaning || (Array.isArray(w) && w[1]) || "",
											hint: w.hint || (Array.isArray(w) && w[2]) || "",
											POS: w.POS || (Array.isArray(w) && w[3]) || "",
										};
									}
								}
							} catch (e) {}
						}
						resolve();
					})
					.catch(() => {
						// fallback: insert module script tag
						if (finished) return;
						const script = document.createElement("script");
						script.src = src;
						script.type = "module";
						script.async = true;
						script.onload = () => {
							if (finished) return;
							finished = true;
							clearTimeout(tid);
							resolve();
						};
						script.onerror = () => {
							if (finished) return;
							finished = true;
							clearTimeout(tid);
							reject(new Error(`failed to load ${src}`));
						};
						document.head.appendChild(script);
					});
			} catch (e) {
				// If import throws synchronously (older browsers), fall back to script tag
				if (finished) return;
				const script = document.createElement("script");
				script.src = src;
				script.type = "module";
				script.async = true;
				script.onload = () => {
					if (finished) return;
					finished = true;
					clearTimeout(tid);
					resolve();
				};
				script.onerror = () => {
					if (finished) return;
					finished = true;
					clearTimeout(tid);
					reject(new Error(`failed to load ${src}`));
				};
				document.head.appendChild(script);
			}
		});
	}

	function loadWordsDataIfNeeded() {
		if (typeof window === "undefined") return Promise.resolve();
		if (window.wordsList && Array.isArray(window.wordsList))
			return Promise.resolve();
		// try a few likely relative paths (from quiz.html in Downloads to Desktop)
		const candidates = [
			"/words-data-section10.js",
			"./words-data-section10.js",
			"../Desktop/words-data-section10.js",
			"../words-data-section10.js"
		];
		// try sequentially until one succeeds or all fail
		let p = Promise.reject();
		for (const c of candidates) {
			p = p.catch(() => loadScript(c).catch(() => Promise.reject()));
		}
		// After attempts, give control back and ensure window.wordsList is used if present
		return p.catch(() => {}).then(() => {});
	}

	// ---- Utilities (grouped) ----
	function getRandomInt(max) {
		return Math.floor(Math.random() * max);
	}

	function shuffleArray(array) {
		const shuffled = [...array];
		for (let i = shuffled.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
		}
		return shuffled;
	}

	// 最長共通部分列の長さ (簡易実装)
	function longestCommonSubstringLength(a, b) {
		const m = a.length,
			n = b.length;
		const dp = Array(m + 1)
			.fill(null)
			.map(() => Array(n + 1).fill(0));
		let max = 0;
		for (let i = 1; i <= m; i++) {
			for (let j = 1; j <= n; j++) {
				if (a[i - 1] === b[j - 1]) {
					dp[i][j] = dp[i - 1][j - 1] + 1;
					if (dp[i][j] > max) max = dp[i][j];
				}
			}
		}
		return max;
	}

	// ---- Question creation & rendering split for readability ----
	function resetUsedWordsIfNeeded(totalWords) {
		if (usedWords.length === totalWords) usedWords = [];
	}

	function chooseWordIndex() {
		const words = cfg.words;
		resetUsedWordsIfNeeded(words.length);
		const available = [];
		for (let i = 0; i < words.length; i++)
			if (!usedWords.includes(i)) available.push(i);
		const chosen = available[getRandomInt(available.length)];
		usedWords.push(chosen);
		return chosen;
	}

	function createChoicesFor(wordIndex) {
		const word = cfg.words[wordIndex];
		const correctAnswer = word[cfg.mode];

		// Use indexed candidate indices where possible to limit work on large lists
		let candidateDistractors = [];
		try {
			const candIdx = getCandidateDistractorIndices(wordIndex);
			candidateDistractors = candIdx.map((i) => cfg.words[i]);
		} catch (e) {
			// fallback to full scan
			candidateDistractors = cfg.words.filter((_, idx) => idx !== wordIndex);
		}

		if (candidateDistractors.length === 0) candidateDistractors = cfg.words.filter((_, idx) => idx !== wordIndex);

		if (cfg.improvements.avoidSimilarDistractors) {
			const target = (correctAnswer + "").toLowerCase();
			candidateDistractors = candidateDistractors.filter((w) => {
				const candidate = (w[cfg.mode] + "").toLowerCase();
				const common = longestCommonSubstringLength(target, candidate);
				return common < Math.max(3, Math.floor(target.length / 2));
			});
		}

		const shuffledDistractors = shuffleArray(candidateDistractors);
		const wrongAnswers = [];
		for (let i = 0; i < cfg.selection - 1 && i < shuffledDistractors.length; i++)
			wrongAnswers.push(shuffledDistractors[i][cfg.mode]);

		// ensure we have enough choices; if not, pull more from full list (rare)
		if (wrongAnswers.length < cfg.selection - 1) {
			const fallback = cfg.words.filter((_, idx) => idx !== wordIndex && !shuffledDistractors.includes(cfg.words[idx]));
			for (let i = 0; i < fallback.length && wrongAnswers.length < cfg.selection - 1; i++)
				wrongAnswers.push(fallback[i][cfg.mode]);
		}

		const choices = shuffleArray([correctAnswer, ...wrongAnswers]);
		const correctIndex = choices.indexOf(correctAnswer);
		return { choices, correctIndex, word };
	}

	function renderChoices(choices) {
		for (let i = 0; i < refs.selectionButtons.length; i++) {
			const btn = refs.selectionButtons[i];
			if (i < choices.length) {
				btn.textContent = choices[i];
				btn.style.display = "flex";
				btn.disabled = false;
				btn.className = "selection-button";
				btn.setAttribute("role", "button");
				btn.setAttribute("aria-pressed", "false");
				btn.tabIndex = 0;
			} else {
				btn.style.display = "none";
				btn.tabIndex = -1;
			}
		}
	}

	// Show friendly message and disable UI when no words are available
	function showNoData() {
		if (!refs) return;
		if (refs.questionText)
			refs.questionText.textContent =
				"単語データが見つかりません。words-data.js を読み込むか、createQuiz に words を渡してください。";
		if (refs.hintText) refs.hintText.textContent = "";
		if (refs.hintButton) refs.hintButton.disabled = true;
		if (Array.isArray(refs.selectionButtons)) {
			refs.selectionButtons.forEach((b) => {
				try {
					b.disabled = true;
					b.textContent = "（データなし）";
				} catch (e) {}
			});
		}
		if (refs.nextButton) {
			refs.nextButton.disabled = true;
			refs.nextButton.textContent = "";
		}
		if (refs.resultText) refs.resultText.textContent = "";
	}

	function changeQuestion() {
		if (cfg.debug) console.debug("changeQuestion: cfg.words[0..3] sample:", cfg.words.slice(0,4));
		const wordIndex = chooseWordIndex();
		const { choices, correctIndex, word } = createChoicesFor(wordIndex);
		currentQuestion = { word, index: wordIndex };

		// Set question text
		// Determine POS (supports new array shape where POS is at index 3,
		// or falls back to a window.wordsMap lookup if present)
		const POS =
			(word && word[3]) ||
			(typeof window !== "undefined" &&
				window.wordsMap &&
				window.wordsMap[word && word[0]] &&
				window.wordsMap[word[0]].POS) ||
			"";
		if (cfg.debug) console.debug("selected word:", word, "POS:", POS);
		const posText = POS ? `（${POS}）` : "";

		if (cfg.mode === 0)
			refs.questionText.textContent = `「${word[1]}」の英単語は？ ${posText}`;
		else refs.questionText.textContent = `「${word[0]}」の意味は？ ${posText}`;

		correctAnswerIndex = correctIndex;
		renderChoices(choices);

		hintUsed = false;
		refs.hintText.textContent = "";
		refs.resultText.textContent = "";
		refs.nextButton.disabled = true;
		refs.nextButton.textContent =
			count < cfg.questionCount - 1 ? cfg.texts.next : cfg.texts.results;
	}
	function handleKeydown(e) {
		const len = refs.selectionButtons.length;
		if (e.key === "ArrowRight" || e.key === "ArrowDown") {
			focusedIndex = (focusedIndex + 1) % len;
			refs.selectionButtons[focusedIndex].focus();
			e.preventDefault();
			return;
		}
		if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
			focusedIndex = (focusedIndex - 1 + len) % len;
			refs.selectionButtons[focusedIndex].focus();
			e.preventDefault();
			return;
		}
		if (e.key === "Enter" || e.key === " ") {
			const idx = refs.selectionButtons.indexOf(document.activeElement);
			if (idx >= 0 && !refs.selectionButtons[idx].disabled) {
				selectAnswer(idx);
				e.preventDefault();
			}
		}
	}

	function nextQuestion() {
		count++;
		if (count < cfg.questionCount) changeQuestion();
		else showResults();
	}

	function showResults() {
		if (cfg.formUrl) sendResultsToGoogleForm(results);
		refs.quizScreen.style.display = "none";
		refs.resultScreen.style.display = "block";

		const correctAnswers = results.filter((r) => r.correct).length;
		// update local stats and show past high score if available
		let stats = null;
		try {
			stats = updateStatsWithSession(results, cfg.questionCount);
		} catch (e) {
			stats = null;
		}
		const highText = stats && typeof stats.highScore === 'number' ? ` (過去最高: ${stats.highScore} / ${cfg.questionCount})` : "";
		refs.scoreDisplay.textContent = `あなたのスコアは ${correctAnswers} / ${cfg.questionCount} です。` + highText;

		refs.resultTableBody.innerHTML = "";
		results.forEach((result) => {
			const row = document.createElement("tr");
			row.innerHTML = `<td>${result.question}</td><td>${
				result.correctAnswer
			}</td><td>${result.hint}</td><td>${result.answer}</td><td style="color: ${
				result.correct ? "#87ceeb" : "#000000"
			}; font-weight: bold;">${result.correct ? "○" : "×"}</td>`;
			refs.resultTableBody.appendChild(row);
		});
	}

	async function sendResultsToGoogleForm(data) {
		if (!cfg.formUrl) return;
		const FORM_URL = cfg.formUrl;
		const ENTRY_IDS = Object.assign(
			{
				question: "entry.962079362",
				correctAnswer: "entry.1340806833",
				answer: "entry.835875996",
				correct: "entry.1281843140",
				hintUsed: "entry.229618259",
			},
			cfg.entryIds
		);
		for (const item of data) {
			const formData = new FormData();
			formData.append(ENTRY_IDS.question, item.question);
			formData.append(ENTRY_IDS.correctAnswer, item.correctAnswer);
			formData.append(ENTRY_IDS.answer, item.answer);
			formData.append(ENTRY_IDS.correct, item.correct ? "正解" : "不正解");
			formData.append(ENTRY_IDS.hintUsed, item.hintUsed ? "はい" : "いいえ");
			try {
				await fetch(FORM_URL, {
					method: "POST",
					body: formData,
					mode: "no-cors",
				});
			} catch (err) {
				console.error("フォーム送信エラー", err);
			}
		}
	}

	function restartQuiz() {
		count = 0;
		results = [];
		usedWords = [];
		focusedIndex = 0;
		refs.quizScreen.style.display = "block";
		refs.resultScreen.style.display = "none";
		changeQuestion();
	}

	function attachUIEvents() {
		refs.hintButton.addEventListener("click", showHint);
		refs.selectionButtons.forEach((btn, idx) => {
			btn.addEventListener("click", () => selectAnswer(idx));
			btn.addEventListener("keydown", handleKeydown);
			btn.addEventListener("focus", () => {
				focusedIndex = idx;
			});
		});
		refs.nextButton.addEventListener("click", nextQuestion);
		if (refs.restartButton)
			refs.restartButton.addEventListener("click", restartQuiz);
	}

	function init(domRefs) {
		refs = domRefs;
		attachUIEvents();
		// If external words-data is available or can be loaded, prefer it
		loadWordsDataIfNeeded()
			.then(() => {
				if (
					typeof window !== "undefined" &&
					window.wordsList &&
					Array.isArray(window.wordsList)
				) {
					// Only adopt window.wordsList if cfg.words is empty (i.e. no options provided and no imported defaults)
					if (!cfg.words || !Array.isArray(cfg.words) || cfg.words.length === 0) {
						cfg.words = normalizeWords(window.wordsList);
					}
				}
			})
			.finally(() => {
				// build index for faster candidate lookup on large data
				try {
					buildIndex();
				} catch (e) {
					// ignore indexing errors
				}
				// If words data is still empty (failed to load), show friendly message and disable UI
				if (!cfg.words || (Array.isArray(cfg.words) && cfg.words.length === 0)) {
					try {
						showNoData();
					} catch (e) {
						// If refs not wired yet, fallback to console warning
						if (cfg.debug) console.warn("単語データが見つかりません: showNoData() 呼び出しに失敗しました");
					}
				} else {
					changeQuestion();
				}
			});
	}

	return {
		init,
		changeQuestion,
		restartQuiz,
		setConfig: (c) => Object.assign(cfg, c),
	};
}


