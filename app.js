(function () {
  "use strict";

  const DEFAULT_POINTS = [
    0.44, 0.47, 0.53, 0.49, 0.43, 0.38, 0.34, 0.36, 0.42, 0.48,
    0.51, 0.46, 0.39, 0.35, 0.37, 0.44, 0.52, 0.57, 0.55, 0.50,
    0.54, 0.62, 0.68, 0.65, 0.59, 0.63, 0.71, 0.78, 0.81, 0.77,
    0.73, 0.79, 0.87, 0.91, 0.88, 0.93
  ];

  function makeSketchPath(values) {
    return values.map((y, index) => ({ x: index / Math.max(1, values.length - 1), y }));
  }

  function cloneSketchPath(points) {
    return points.map((point) => ({ x: point.x, y: point.y }));
  }

  function orderedSketchPoints() {
    return state.points.slice().sort((left, right) => left.x - right.x);
  }

  function sampleSketchPath(points, count = 64) {
    if (points.length < 2) return [];
    const ordered = points.slice().sort((left, right) => left.x - right.x);
    const startX = ordered[0].x;
    const endX = ordered[ordered.length - 1].x;
    const xSpan = endX - startX;
    const samples = [];
    let rightIndex = 1;
    for (let index = 0; index < count; index += 1) {
      const x = startX + (index / Math.max(1, count - 1)) * xSpan;
      while (rightIndex < ordered.length - 1 && ordered[rightIndex].x < x) rightIndex += 1;
      const left = ordered[Math.max(0, rightIndex - 1)];
      const right = ordered[rightIndex] || left;
      const span = right.x - left.x;
      const weight = span > 0 ? (x - left.x) / span : 0;
      samples.push(clamp(left.y + (right.y - left.y) * weight));
    }
    return samples;
  }

  const WATCHLIST_STORAGE_KEY = "pattern-mirror.watchlist.v1";

  function readWatchlist() {
    try {
      const stored = JSON.parse(localStorage.getItem(WATCHLIST_STORAGE_KEY) || "[]");
      return Array.isArray(stored) ? stored.filter((code) => typeof code === "string").slice(0, 100) : [];
    } catch (error) {
      return [];
    }
  }

  function saveWatchlist(codes) {
    state.watchlist = Array.from(new Set(codes)).slice(0, 100);
    try {
      localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(state.watchlist));
    } catch (error) {
      // Private browsing can deny storage; the in-memory list still works.
    }
    $("#watchlist-count").textContent = state.watchlist.length;
  }

  const state = {
    points: makeSketchPath(DEFAULT_POINTS),
    previousPoints: makeSketchPath(DEFAULT_POINTS),
    drawPoints: makeSketchPath(DEFAULT_POINTS),
    uploadPoints: [],
    mode: "draw",
    uploadImage: null,
    uploadFile: null,
    uploadDisplay: null,
    uploadCrop: null,
    uploadDrag: null,
    uploadCandleCount: null,
    lookback: 40,
    searchMode: "current",
    recentDays: 20,
    activeView: "search",
    watchlist: readWatchlist(),
    watchQuotes: [],
    scanResults: [],
    scanTotal: 0,
    scanMarket: "all",
    scanMode: "current",
    scanMinScore: 90,
    scanPhase: "all",
    scanLoading: false,
    updatePollTimer: null,
    searchDebounceTimer: null,
    searchPending: false,
    updateStatus: "idle",
    market: "all",
    results: [],
    selectedIndex: 0,
    overview: null,
    loading: false,
    fallback: false,
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const sketchCanvas = $("#sketch-canvas");
  const sketchWrap = $(".sketch-wrap");
  const mainCanvas = $("#main-chart");
  const dataUpdatePanel = $("#data-update-panel");
  const dataUpdateRunButton = $("#data-update-run");
  const dataUpdateLog = $("#data-update-log");
  const searchView = $("#search-view");
  const scanView = $("#scan-view");
  const watchlistView = $("#watchlist-view");
  const appViews = { search: searchView, scan: scanView, watchlist: watchlistView };
  const uploadInput = $("#upload-input");
  const uploadTools = $("#upload-tools");
  const uploadFileName = $("#upload-file-name");
  const uploadFileStatus = $("#upload-file-status");
  const extractUploadButton = $("#extract-upload");
  const screenshotWindowOption = $("#screenshot-window-option");
  const screenshotWindowLabel = $("#screenshot-window-label");
  const uploadDetection = $("#upload-detection");
  const candleCountValue = $("#candle-count-value");
  const candleConfidence = $("#candle-confidence");
  const recentOptions = $("#recent-options");
  const searchModeButtons = $$('[data-mode]');
  const sketchContext = sketchCanvas.getContext("2d");
  const mainContext = mainCanvas.getContext("2d");

  function clamp(value, min = 0, max = 1) {
    return Math.max(min, Math.min(max, value));
  }

  function formatPercent(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
    const numeric = Number(value);
    return `${numeric >= 0 ? "+" : ""}${numeric.toFixed(1)}%`;
  }

  function formatDate(value) {
    if (!value) return "—";
    return String(value).replaceAll("-", ".");
  }

  function codeLabel(code) {
    return code || "—";
  }

  function resizeCanvas(canvas, context) {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    return { width: rect.width, height: rect.height };
  }

  function setCanvasHint(message, icon = "✎") {
    $("#canvas-hint").innerHTML = `<span class="hint-pencil">${icon}</span> ${message}`;
  }

  function imageFileSize(bytes) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function uploadPointFromEvent(event) {
    if (!state.uploadDisplay) return null;
    const rect = sketchCanvas.getBoundingClientRect();
    const display = state.uploadDisplay;
    const x = (event.clientX - rect.left - display.x) / Math.max(1, display.width);
    const y = (event.clientY - rect.top - display.y) / Math.max(1, display.height);
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  function normalizedCrop(start, end) {
    const x = Math.max(0, Math.min(start.x, end.x));
    const y = Math.max(0, Math.min(start.y, end.y));
    const right = Math.min(1, Math.max(start.x, end.x));
    const bottom = Math.min(1, Math.max(start.y, end.y));
    return { x, y, width: right - x, height: bottom - y };
  }

  function cropPixels(crop, width, height) {
    return { x: crop.x * width, y: crop.y * height, width: crop.width * width, height: crop.height * height };
  }

  function drawUploadCurvePreview(display, cropRect) {
    const points = orderedSketchPoints();
    if (points.length < 2) return;
    sketchContext.beginPath();
    points.forEach((point, index) => {
      const x = display.x + cropRect.x + clamp(point.x) * cropRect.width;
      const y = display.y + cropRect.y + (1 - clamp(point.y)) * cropRect.height;
      if (index === 0) sketchContext.moveTo(x, y);
      else sketchContext.lineTo(x, y);
    });
    sketchContext.strokeStyle = "#e5c08e";
    sketchContext.lineWidth = 2.2;
    sketchContext.lineJoin = "round";
    sketchContext.lineCap = "round";
    sketchContext.shadowColor = "rgba(214,179,130,.5)";
    sketchContext.shadowBlur = 8;
    sketchContext.stroke();
    sketchContext.shadowBlur = 0;
    const last = points[points.length - 1];
    sketchContext.beginPath();
    sketchContext.arc(display.x + cropRect.x + clamp(last.x) * cropRect.width, display.y + cropRect.y + (1 - clamp(last.y)) * cropRect.height, 3.2, 0, Math.PI * 2);
    sketchContext.fillStyle = "#63c1a9";
    sketchContext.fill();
  }

  function drawUploadPreview() {
    const { width, height } = resizeCanvas(sketchCanvas, sketchContext);
    sketchContext.clearRect(0, 0, width, height);
    const image = state.uploadImage;
    if (!image) {
      state.uploadDisplay = null;
      sketchContext.fillStyle = "#111c22";
      sketchContext.fillRect(0, 0, width, height);
      $("#canvas-hint").classList.remove("hidden");
      setCanvasHint("点击选择，或把走势图截图拖到这里", "↑");
      return;
    }

    const imageRatio = image.naturalWidth / image.naturalHeight;
    const canvasRatio = width / height;
    const displayWidth = canvasRatio > imageRatio ? height * imageRatio : width;
    const displayHeight = canvasRatio > imageRatio ? height : width / imageRatio;
    const display = { x: (width - displayWidth) / 2, y: (height - displayHeight) / 2, width: displayWidth, height: displayHeight };
    state.uploadDisplay = display;
    const rawCrop = state.uploadCrop || { x: 0, y: 0, width: 1, height: 1 };
    const crop = { ...rawCrop, width: Math.max(rawCrop.width, 0.001), height: Math.max(rawCrop.height, 0.001) };
    const cropRect = cropPixels(crop, display.width, display.height);

    sketchContext.fillStyle = "#10191e";
    sketchContext.fillRect(0, 0, width, height);
    sketchContext.drawImage(image, display.x, display.y, display.width, display.height);
    sketchContext.fillStyle = "rgba(7, 13, 17, .53)";
    sketchContext.fillRect(0, 0, width, height);
    sketchContext.drawImage(
      image,
      crop.x * image.naturalWidth,
      crop.y * image.naturalHeight,
      crop.width * image.naturalWidth,
      crop.height * image.naturalHeight,
      display.x + cropRect.x,
      display.y + cropRect.y,
      cropRect.width,
      cropRect.height,
    );
    sketchContext.strokeStyle = "rgba(232, 200, 149, .9)";
    sketchContext.lineWidth = 1.2;
    sketchContext.strokeRect(display.x + cropRect.x, display.y + cropRect.y, cropRect.width, cropRect.height);
    sketchContext.fillStyle = "rgba(214,179,130,.95)";
    sketchContext.font = "10px Segoe UI";
    sketchContext.textAlign = "left";
    sketchContext.fillText(state.points.length > 1 ? "已提取走势 · 拖动边界可重新框选" : "拖动框选有效图表区域", display.x + cropRect.x + 7, display.y + cropRect.y + 15);
    drawUploadCurvePreview(display, cropRect);
    $("#canvas-hint").classList.add("hidden");
  }

  function drawSketch() {
    if (state.mode === "upload") {
      drawUploadPreview();
      return;
    }
    const { width, height } = resizeCanvas(sketchCanvas, sketchContext);
    sketchContext.clearRect(0, 0, width, height);
    if (!state.points.length) {
      $("#canvas-hint").classList.remove("hidden");
      return;
    }
    $("#canvas-hint").classList.add("hidden");
    const padX = 16;
    const padY = 19;
    const plotWidth = Math.max(1, width - padX * 2);
    const plotHeight = Math.max(1, height - padY * 2 - 17);
    sketchContext.beginPath();
    const points = orderedSketchPoints();
    points.forEach((point, index) => {
      const x = padX + clamp(point.x) * plotWidth;
      const y = padY + (1 - clamp(point.y)) * plotHeight;
      if (index === 0) sketchContext.moveTo(x, y);
      else sketchContext.lineTo(x, y);
    });
    sketchContext.strokeStyle = "#e5c08e";
    sketchContext.lineWidth = 2.1;
    sketchContext.lineJoin = "round";
    sketchContext.lineCap = "round";
    sketchContext.shadowColor = "rgba(214,179,130,.35)";
    sketchContext.shadowBlur = 9;
    sketchContext.stroke();
    sketchContext.shadowBlur = 0;
    const last = points[points.length - 1];
    const lastX = padX + clamp(last.x) * plotWidth;
    const lastY = padY + (1 - clamp(last.y)) * plotHeight;
    sketchContext.beginPath();
    sketchContext.arc(lastX, lastY, 3.2, 0, Math.PI * 2);
    sketchContext.fillStyle = "#63c1a9";
    sketchContext.fill();
  }

  function extractCurveFromImage() {
    const image = state.uploadImage;
    const crop = state.uploadCrop;
    if (!image || !crop || crop.width <= 0 || crop.height <= 0) return null;

    const sourceX = crop.x * image.naturalWidth;
    const sourceY = crop.y * image.naturalHeight;
    const sourceWidth = crop.width * image.naturalWidth;
    const sourceHeight = crop.height * image.naturalHeight;
    const width = Math.max(96, Math.min(260, Math.round(sourceWidth)));
    const height = Math.max(48, Math.min(220, Math.round(sourceHeight * width / Math.max(1, sourceWidth))));
    const imageCanvas = document.createElement("canvas");
    imageCanvas.width = width;
    imageCanvas.height = height;
    const imageContext = imageCanvas.getContext("2d", { willReadFrequently: true });
    imageContext.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
    const pixels = imageContext.getImageData(0, 0, width, height).data;

    const borderLuma = [];
    const readLuma = (x, y) => {
      const offset = (y * width + x) * 4;
      return pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
    };
    const borderStep = Math.max(1, Math.floor(Math.max(width, height) / 24));
    for (let x = 0; x < width; x += borderStep) {
      borderLuma.push(readLuma(x, 0), readLuma(x, height - 1));
    }
    for (let y = 0; y < height; y += borderStep) {
      borderLuma.push(readLuma(0, y), readLuma(width - 1, y));
    }
    const backgroundLuma = borderLuma.reduce((sum, value) => sum + value, 0) / Math.max(1, borderLuma.length);
    const scores = Array.from({ length: width }, () => new Float32Array(height));
    for (let x = 0; x < width; x += 1) {
      for (let y = 0; y < height; y += 1) {
        const offset = (y * width + x) * 4;
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        const luma = red * 0.299 + green * 0.587 + blue * 0.114;
        const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
        const contrast = Math.abs(luma - backgroundLuma);
        const colorScore = chroma > 14 ? clamp((chroma - 14) / 92) : 0;
        const contrastScore = contrast > 20 ? clamp((contrast - 20) / 105) : 0;
        scores[x][y] = Math.max(colorScore, contrastScore * 0.72);
      }
    }

    const backtrack = Array.from({ length: width }, () => new Int16Array(height));
    let previous = new Float32Array(height);
    for (let y = 0; y < height; y += 1) {
      const centerBias = Math.abs(y - height / 2) / height;
      previous[y] = centerBias * 0.08 - scores[0][y];
    }
    const maxJump = Math.max(4, Math.round(height * 0.12));
    const jumpPenalty = 0.035;
    for (let x = 1; x < width; x += 1) {
      const current = new Float32Array(height);
      for (let y = 0; y < height; y += 1) {
        let bestValue = Number.POSITIVE_INFINITY;
        let bestPrevious = y;
        const from = Math.max(0, y - maxJump);
        const to = Math.min(height - 1, y + maxJump);
        for (let previousY = from; previousY <= to; previousY += 1) {
          const candidate = previous[previousY] + Math.abs(y - previousY) * jumpPenalty;
          if (candidate < bestValue) {
            bestValue = candidate;
            bestPrevious = previousY;
          }
        }
        current[y] = bestValue + 0.34 - scores[x][y];
        backtrack[x][y] = bestPrevious;
      }
      previous = current;
    }

    let bestY = 0;
    for (let y = 1; y < height; y += 1) if (previous[y] < previous[bestY]) bestY = y;
    const path = new Array(width);
    path[width - 1] = bestY;
    for (let x = width - 1; x > 0; x -= 1) path[x - 1] = backtrack[x][path[x]];
    const smoothRadius = Math.max(1, Math.round(height / 70));
    const smoothPath = path.map((_, index) => {
      let total = 0;
      let count = 0;
      for (let offset = -smoothRadius; offset <= smoothRadius; offset += 1) {
        const target = index + offset;
        if (target >= 0 && target < path.length) {
          total += path[target];
          count += 1;
        }
      }
      return total / Math.max(1, count);
    });
    const pathScores = smoothPath.map((y, index) => scores[index][Math.max(0, Math.min(height - 1, Math.round(y)))]);
    const quality = pathScores.reduce((sum, value) => sum + value, 0) / Math.max(1, pathScores.length);
    const validRatio = pathScores.filter((value) => value > 0.12).length / Math.max(1, pathScores.length);
    const pathMin = Math.min(...smoothPath);
    const pathMax = Math.max(...smoothPath);
    if (quality < 0.07 || validRatio < 0.22 || pathMax - pathMin < 2) return null;

    const values = smoothPath.map((y) => 1 - (y - pathMin) / Math.max(1, pathMax - pathMin));
    return { values, quality: Math.min(1, quality * 1.6), validRatio };
  }

  function detectCandlesFromImage() {
    const image = state.uploadImage;
    const crop = state.uploadCrop;
    if (!image || !crop || crop.width <= 0 || crop.height <= 0) return null;
    const sourceX = crop.x * image.naturalWidth;
    const sourceY = crop.y * image.naturalHeight;
    const sourceWidth = crop.width * image.naturalWidth;
    const sourceHeight = crop.height * image.naturalHeight;
    const width = Math.max(160, Math.min(520, Math.round(sourceWidth)));
    const height = Math.max(80, Math.min(260, Math.round(sourceHeight * width / Math.max(1, sourceWidth))));
    const imageCanvas = document.createElement("canvas");
    imageCanvas.width = width;
    imageCanvas.height = height;
    const imageContext = imageCanvas.getContext("2d", { willReadFrequently: true });
    imageContext.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
    const pixels = imageContext.getImageData(0, 0, width, height).data;
    const columnScore = new Float32Array(width);
    const columnMinY = new Int16Array(width);
    const columnMaxY = new Int16Array(width);
    columnMinY.fill(height);
    columnMaxY.fill(-1);
    let candlePixelCount = 0;

    function isCandlePixel(red, green, blue) {
      const maxChannel = Math.max(red, green, blue);
      const minChannel = Math.min(red, green, blue);
      const chroma = maxChannel - minChannel;
      const saturation = maxChannel > 0 ? chroma / maxChannel : 0;
      if (saturation < 0.22 || chroma < 24 || maxChannel < 38) return false;
      const delta = maxChannel - minChannel;
      let hue = 0;
      if (delta > 0) {
        if (maxChannel === red) hue = 60 * (((green - blue) / delta) % 6);
        else if (maxChannel === green) hue = 60 * ((blue - red) / delta + 2);
        else hue = 60 * ((red - green) / delta + 4);
        if (hue < 0) hue += 360;
      }
      return hue < 28 || hue > 334 || (hue > 58 && hue < 190);
    }

    for (let x = 0; x < width; x += 1) {
      for (let y = 0; y < height; y += 1) {
        const offset = (y * width + x) * 4;
        if (!isCandlePixel(pixels[offset], pixels[offset + 1], pixels[offset + 2])) continue;
        columnScore[x] += 1;
        columnMinY[x] = Math.min(columnMinY[x], y);
        columnMaxY[x] = Math.max(columnMaxY[x], y);
        candlePixelCount += 1;
      }
    }
    if (candlePixelCount < Math.max(12, width * 0.04)) return null;

    const nonZeroScores = Array.from(columnScore).filter((score) => score > 0).sort((a, b) => a - b);
    const percentile = (values, ratio) => values[Math.min(values.length - 1, Math.floor(values.length * ratio))] || 0;
    const scoreFloor = Math.max(2, Math.round(height * 0.012), Math.round(percentile(nonZeroScores, 0.8) * 0.18));
    const spanFloor = Math.max(3, Math.round(height * 0.018));
    const signal = new Float32Array(width);
    for (let x = 0; x < width; x += 1) {
      const span = columnMaxY[x] >= 0 ? columnMaxY[x] - columnMinY[x] + 1 : 0;
      if (columnScore[x] >= scoreFloor && span >= spanFloor) signal[x] = columnScore[x];
    }

    const localPeaks = [];
    const peakRadius = Math.max(1, Math.round(width / 180));
    for (let x = peakRadius; x < width - peakRadius; x += 1) {
      if (signal[x] < scoreFloor) continue;
      let isPeak = true;
      for (let offset = 1; offset <= peakRadius; offset += 1) {
        if (signal[x] < signal[x - offset] || signal[x] < signal[x + offset]) {
          isPeak = false;
          break;
        }
      }
      if (isPeak) localPeaks.push({ x, score: signal[x] });
    }
    if (localPeaks.length < 2) return null;

    function selectPeaks(candidates, minDistance) {
      const selected = [];
      candidates.slice().sort((left, right) => right.score - left.score).forEach((candidate) => {
        if (selected.every((chosen) => Math.abs(chosen.x - candidate.x) >= minDistance)) selected.push(candidate);
      });
      return selected.sort((left, right) => left.x - right.x);
    }

    const preliminary = selectPeaks(localPeaks, Math.max(2, Math.round(width / 150)));
    if (preliminary.length < 2) return null;
    const preliminaryGaps = preliminary.slice(1).map((peak, index) => peak.x - preliminary[index].x);
    const usableGaps = preliminaryGaps.filter((gap) => gap >= Math.max(3, Math.round(width / 150)));
    const typicalGap = usableGaps.length ? percentile(usableGaps.sort((a, b) => a - b), 0.75) : width / preliminary.length;
    const finalPeaks = selectPeaks(localPeaks, Math.max(2, Math.round(typicalGap * 0.55)));
    if (finalPeaks.length < 2) return null;

    const centers = finalPeaks.map((peak) => peak.x);
    const gaps = centers.slice(1).map((center, index) => center - centers[index]);
    const gapMedian = percentile(gaps.slice().sort((a, b) => a - b), 0.5) || typicalGap;
    const normalizedGaps = gaps.map((gap) => gap / Math.max(1, gapMedian));
    const gapRegularity = normalizedGaps.length ? clamp(1 - normalizedGaps.reduce((sum, gap) => sum + Math.abs(gap - 1), 0) / normalizedGaps.length) : 0;
    let inferredCount = finalPeaks.length;
    if (gapRegularity > 0.7) {
      gaps.forEach((gap) => {
        if (gap > gapMedian * 1.8) inferredCount += Math.min(2, Math.max(0, Math.round(gap / gapMedian) - 1));
      });
    }
    const bodySignalRatio = signal.filter((score) => score > 0).length / Math.max(1, width);
    const confidence = clamp(0.42 + gapRegularity * 0.34 + Math.min(0.18, bodySignalRatio * 0.9) + Math.min(0.12, candlePixelCount / (width * height) * 1.5));
    return { count: Math.min(160, Math.max(2, inferredCount)), confidence };
  }

  function updateLookbackButtons() {
    $$(`[data-lookback]`).forEach((button) => {
      const value = button.dataset.lookback === "screenshot" ? state.uploadCandleCount : Number(button.dataset.lookback);
      button.classList.toggle("active", Number.isFinite(value) && value === state.lookback);
    });
  }

  function applyCandleDetection(detection) {
    if (!detection || detection.count < 2) {
      state.uploadCandleCount = null;
      screenshotWindowOption.hidden = true;
      uploadDetection.hidden = true;
      state.lookback = 40;
      updateLookbackButtons();
      return;
    }
    state.uploadCandleCount = Math.max(5, Math.min(160, Math.round(detection.count)));
    state.lookback = state.uploadCandleCount;
    screenshotWindowLabel.textContent = `${state.uploadCandleCount} 根`;
    candleCountValue.textContent = state.uploadCandleCount;
    candleConfidence.textContent = `置信度 ${Math.round(detection.confidence * 100)}%`;
    screenshotWindowOption.hidden = false;
    uploadDetection.hidden = state.mode !== "upload";
    updateLookbackButtons();
  }

  function adjustCandleCount(delta) {
    if (!state.uploadCandleCount) return;
    state.uploadCandleCount = Math.max(5, Math.min(160, state.uploadCandleCount + delta));
    state.lookback = state.uploadCandleCount;
    screenshotWindowLabel.textContent = `${state.uploadCandleCount} 根`;
    candleCountValue.textContent = state.uploadCandleCount;
    candleConfidence.textContent = "已手动调整";
    uploadFileStatus.textContent = `已手动调整为 ${state.uploadCandleCount} 根 K 线`;
    updateLookbackButtons();
    runSearch();
  }

  function extractUploadCurve() {
    if (!state.uploadImage) return false;
    uploadFileStatus.textContent = "正在从框选区域提取走势线…";
    const extracted = extractCurveFromImage();
    if (!extracted) {
      state.points = [];
      state.uploadPoints = [];
      extractUploadButton.disabled = false;
      uploadFileStatus.textContent = "没有找到连续走势线，请缩小框选区域后重试";
      drawUploadPreview();
      return false;
    }
    state.points = makeSketchPath(extracted.values);
    state.uploadPoints = cloneSketchPath(state.points);
    extractUploadButton.disabled = false;
    uploadFileStatus.textContent = `已提取走势 · 识别置信度 ${Math.round(extracted.quality * 100)}%`;
    drawUploadPreview();
    return true;
  }

  function pointFromEvent(event) {
    const rect = sketchCanvas.getBoundingClientRect();
    const plotWidth = Math.max(1, rect.width - 32);
    const plotHeight = Math.max(1, rect.height - 55);
    const x = clamp((event.clientX - rect.left - 16) / plotWidth);
    const y = clamp((event.clientY - rect.top - 19) / plotHeight);
    return { x, y: 1 - y };
  }

  function addSketchPoint(event) {
    const point = pointFromEvent(event);
    const previous = state.points[state.points.length - 1];
    if (previous && Math.abs(point.x - previous.x) < 0.002 && Math.abs(point.y - previous.y) < 0.002) return;
    state.points.push(point);
    drawSketch();
  }

  function scheduleSketchSearch() {
    if (state.mode !== "draw" || state.points.length < 2) return;
    window.clearTimeout(state.searchDebounceTimer);
    state.searchDebounceTimer = window.setTimeout(() => {
      state.searchDebounceTimer = null;
      runSearch();
    }, 180);
  }

  function updateInputTabs() {
    const drawTab = $("#draw-tab");
    const uploadTab = $("#upload-tab");
    drawTab.classList.toggle("active", state.mode === "draw");
    uploadTab.classList.toggle("active", state.mode === "upload");
    drawTab.setAttribute("aria-selected", state.mode === "draw" ? "true" : "false");
    uploadTab.setAttribute("aria-selected", state.mode === "upload" ? "true" : "false");
    uploadTools.hidden = state.mode !== "upload";
    extractUploadButton.disabled = !state.uploadImage;
    uploadDetection.hidden = state.mode !== "upload" || !state.uploadCandleCount;
    screenshotWindowOption.hidden = state.mode !== "upload" || !state.uploadCandleCount;
  }

  function setInputMode(mode) {
    if (mode === state.mode) {
      updateInputTabs();
      if (mode === "upload" && !state.uploadImage) uploadInput.click();
      return;
    }
    if (state.mode === "draw") state.drawPoints = cloneSketchPath(state.points);
    if (state.mode === "upload") state.uploadPoints = cloneSketchPath(state.points);
    state.mode = mode;
    if (mode === "upload" && state.uploadCandleCount) state.lookback = state.uploadCandleCount;
    if (mode === "draw" && state.lookback === state.uploadCandleCount) state.lookback = 40;
    state.points = mode === "upload"
      ? cloneSketchPath(state.uploadPoints)
      : cloneSketchPath(state.drawPoints.length ? state.drawPoints : makeSketchPath(DEFAULT_POINTS));
    updateInputTabs();
    if (mode === "upload") {
      if (!state.uploadImage) setCanvasHint("点击选择，或把走势图截图拖到这里", "↑");
      uploadFileStatus.textContent = state.uploadFile ? uploadFileStatus.textContent : "支持 PNG / JPG / WEBP，图片只在本地处理";
      drawSketch();
      if (!state.uploadImage) uploadInput.click();
    } else {
      setCanvasHint("在这里画出你的走势", "✎");
      drawSketch();
    }
  }

  function loadUploadFile(file) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      uploadFileStatus.textContent = "请选择 PNG、JPG 或 WEBP 图片";
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      uploadFileStatus.textContent = "图片不能超过 15 MB，请压缩后重试";
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      state.uploadImage = image;
      state.uploadFile = file;
      state.uploadCrop = { x: 0, y: 0, width: 1, height: 1 };
      state.uploadDrag = null;
      state.uploadCandleCount = null;
      state.points = [];
      state.uploadPoints = [];
      uploadFileName.textContent = file.name;
      uploadFileStatus.textContent = `${image.naturalWidth} × ${image.naturalHeight} · ${imageFileSize(file.size)} · 正在识别`;
      applyCandleDetection(detectCandlesFromImage());
      updateInputTabs();
      drawSketch();
      extractUploadCurve();
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      uploadFileStatus.textContent = "图片读取失败，请换一张图片重试";
    };
    image.src = objectUrl;
  }

  function finishUploadCrop() {
    if (!state.uploadDrag) return;
    const crop = normalizedCrop(state.uploadDrag.start, state.uploadDrag.current);
    state.uploadDrag = null;
    if (crop.width < 0.04 || crop.height < 0.04) {
      state.uploadCrop = { x: 0, y: 0, width: 1, height: 1 };
      uploadFileStatus.textContent = "已恢复全图区域，可拖动框选后重新提取";
      applyCandleDetection(detectCandlesFromImage());
    } else {
      state.uploadCrop = crop;
      state.points = [];
      applyCandleDetection(detectCandlesFromImage());
      uploadFileStatus.textContent = "已更新框选区域，正在重新提取走势线…";
      extractUploadCurve();
    }
    drawUploadPreview();
  }

  uploadInput.addEventListener("change", (event) => {
    loadUploadFile(event.target.files[0]);
    event.target.value = "";
  });
  $("#choose-upload").addEventListener("click", () => {
    if (state.mode !== "upload") setInputMode("upload");
    else uploadInput.click();
  });
  extractUploadButton.addEventListener("click", extractUploadCurve);
  $("#candle-minus").addEventListener("click", () => adjustCandleCount(-1));
  $("#candle-plus").addEventListener("click", () => adjustCandleCount(1));
  $("#draw-tab").addEventListener("click", () => setInputMode("draw"));
  $("#upload-tab").addEventListener("click", () => setInputMode("upload"));
  sketchWrap.addEventListener("dragover", (event) => {
    if (state.mode !== "upload") return;
    event.preventDefault();
    sketchWrap.classList.add("drop-active");
  });
  sketchWrap.addEventListener("dragleave", () => sketchWrap.classList.remove("drop-active"));
  sketchWrap.addEventListener("drop", (event) => {
    if (state.mode !== "upload") return;
    event.preventDefault();
    sketchWrap.classList.remove("drop-active");
    loadUploadFile(event.dataTransfer.files[0]);
  });

  sketchCanvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    if (state.mode === "upload") {
      if (!state.uploadImage) {
        uploadInput.click();
        return;
      }
      const point = uploadPointFromEvent(event);
      if (!point) return;
      state.uploadDrag = { start: point, current: point };
      sketchCanvas.setPointerCapture(event.pointerId);
      return;
    }
    state.previousPoints = state.points.length ? cloneSketchPath(state.points) : makeSketchPath(DEFAULT_POINTS);
    state.points = [];
    sketchCanvas.setPointerCapture(event.pointerId);
    addSketchPoint(event);
  });
  sketchCanvas.addEventListener("pointermove", (event) => {
    if (state.mode === "upload") {
      if (!state.uploadDrag || !sketchCanvas.hasPointerCapture(event.pointerId)) return;
      const point = uploadPointFromEvent(event);
      if (!point) return;
      state.uploadDrag.current = point;
      state.uploadCrop = normalizedCrop(state.uploadDrag.start, point);
      state.points = [];
      drawUploadPreview();
      return;
    }
    if (sketchCanvas.hasPointerCapture(event.pointerId)) addSketchPoint(event);
  });
  sketchCanvas.addEventListener("pointerup", (event) => {
    if (state.mode === "upload") {
      finishUploadCrop();
      if (sketchCanvas.hasPointerCapture(event.pointerId)) sketchCanvas.releasePointerCapture(event.pointerId);
      return;
    }
    if (sketchCanvas.hasPointerCapture(event.pointerId)) sketchCanvas.releasePointerCapture(event.pointerId);
    scheduleSketchSearch();
  });
  sketchCanvas.addEventListener("pointercancel", (event) => {
    if (state.mode === "upload") state.uploadDrag = null;
    if (sketchCanvas.hasPointerCapture(event.pointerId)) sketchCanvas.releasePointerCapture(event.pointerId);
  });

  function createFallbackResults() {
    const codes = ["000001.SZ", "600519.SH", "300750.SZ", "002594.SZ", "688981.SH", "601318.SH", "000858.SZ", "600036.SH"];
    const base = state.points.length > 2 ? sampleSketchPath(state.points, 64) : DEFAULT_POINTS;
    const isHistory = state.searchMode === "history";
    return codes.map((code, index) => {
      const pattern = Array.from({ length: 32 }, (_, i) => clamp((base[Math.floor((i / 31) * (base.length - 1))] || .5) + Math.sin(i * .55 + index) * .035 - index * .008));
      const candles = Array.from({ length: 53 }, (_, i) => {
        const value = 90 + i * 0.38 + Math.sin(i * .38 + index) * 3.4 + Math.sin(i * .11) * 2;
        const open = value + Math.sin(i * .7 + index) * 1.3;
        const close = value + Math.cos(i * .5 + index) * 1.4;
        return { date: `2025-${String(Math.min(12, 7 + Math.floor(i / 22))).padStart(2, "0")}-${String(1 + (i % 21)).padStart(2, "0")}`, open, high: Math.max(open, close) + 1.2, low: Math.min(open, close) - 1.1, close, match: i < 40 };
      });
      return { code, exchange: code.endsWith("SZ") ? "深市" : "沪市", group: index % 3 === 0 ? "主板" : "成长", score: 97.4 - index * 2.6, priority_score: 97.4 - index * 2.6, match_start: isHistory ? "2025-07-01" : "2026-07-01", match_end: isHistory ? "2025-08-26" : "2026-09-14", latest_date: "2026-09-14", latest_price: 128.4 - index * 3.2, forward_return: isHistory ? 18.4 - index * 4.1 : null, volume_ratio: 1.1 + index * .08, phase: isHistory ? (index % 3 === 2 ? "震荡整理" : "加速上行") : (index % 3 === 2 ? "近期形态" : "当前候选"), match_age_bars: state.searchMode === "recent" ? index % 7 : 0, is_current: state.searchMode !== "recent" || index % 7 === 0, history_stats: isHistory ? null : { count: 30, hit_rate: 54.0 - index, median_return: 3.6 - index * .4, p25_return: -2.4 - index * .2, p75_return: 8.1 - index * .5, median_drawdown: -5.1 - index * .2 }, pattern, candles, rank: index + 1 };
    });
  }

  function modeLabel() {
    if (state.searchMode === "history") return "历史研究";
    if (state.searchMode === "recent") return `近期 ${state.recentDays} 日`;
    return "当前候选";
  }

  function updateSearchModeControls() {
    searchModeButtons.forEach((button) => button.classList.toggle("active", button.dataset.mode === state.searchMode));
    recentOptions.hidden = state.searchMode !== "recent";
    $$('[data-recent-days]').forEach((button) => button.classList.toggle("active", Number(button.dataset.recentDays) === state.recentDays));
  }

  function setSearchMode(mode) {
    if (!["current", "recent", "history"].includes(mode)) return;
    state.searchMode = mode;
    updateSearchModeControls();
    runSearch();
  }

  function isWatched(code) {
    return state.watchlist.includes(code);
  }

  function toggleWatchlist(code, event) {
    if (event) event.stopPropagation();
    if (isWatched(code)) saveWatchlist(state.watchlist.filter((item) => item !== code));
    else saveWatchlist([...state.watchlist, code]);
    renderResults();
    renderScanView();
    if (state.activeView === "watchlist") loadWatchlist();
  }

  function updateViewNavigation() {
    $$('[data-view]').forEach((button) => button.classList.toggle("active", button.dataset.view === state.activeView));
    Object.entries(appViews).forEach(([view, element]) => {
      element.hidden = view !== state.activeView;
      element.classList.toggle("active", view === state.activeView);
    });
    const labels = { search: "形态搜索", scan: "市场扫描", watchlist: "观察列表" };
    $(".breadcrumbs strong").textContent = labels[state.activeView];
    $("#watchlist-count").textContent = state.watchlist.length;
  }

  function setActiveView(view) {
    if (!appViews[view]) return;
    state.activeView = view;
    updateViewNavigation();
    if (view === "scan") {
      if (!state.scanResults.length) runMarketScan();
      else renderScanView();
    }
    if (view === "watchlist") loadWatchlist();
  }

  function scanPhaseMatches(result) {
    if (state.scanPhase === "all") return true;
    if (state.scanPhase === "current") return Number(result.match_age_bars) === 0;
    if (state.scanPhase === "trend") return ["趋势偏强", "加速上行"].includes(result.phase);
    if (state.scanPhase === "watch") return ["回撤观察", "震荡整理"].includes(result.phase);
    return true;
  }

  function scanHistoryText(result) {
    const stats = result.history_stats;
    if (!stats || !stats.count) return "—";
    return `${Number(stats.hit_rate).toFixed(1)}% · ${formatPercent(stats.median_return)}`;
  }

  function renderScanView() {
    const results = (state.scanResults || []).filter((result) => Number(result.score) >= state.scanMinScore && scanPhaseMatches(result));
    const body = $("#scan-table-body");
    $("#scan-result-count").textContent = `${results.length} 个候选`;
    $("#scan-result-caption").textContent = `${state.scanMode === "current" ? "当前窗口" : state.scanMode === "recent" ? `近 ${state.recentDays} 日` : "历史样本"} · 已按优先级排序`;
    $("#scan-pool-count").textContent = state.scanTotal || state.scanResults.length || "—";
    $("#scan-current-count").textContent = state.scanResults.length ? state.scanResults.filter((result) => Number(result.match_age_bars) === 0).length : "—";
    $("#scan-average-score").textContent = results.length ? (results.reduce((sum, result) => sum + Number(result.score), 0) / results.length).toFixed(1) : "—";
    if (state.scanLoading) {
      body.innerHTML = '<div class="scan-empty">正在扫描候选池…</div>';
      return;
    }
    if (!results.length) {
      body.innerHTML = '<div class="scan-empty">没有符合当前条件的候选，请放宽最低相似度或调整扫描模式。</div>';
      return;
    }
    body.innerHTML = results.map((result, index) => `
      <div class="scan-row" data-code="${result.code}">
        <div class="scan-symbol"><span class="scan-rank">${String(index + 1).padStart(2, "0")}</span><div><strong>${codeLabel(result.code)}</strong><small>${result.exchange || "A 股"} · ${result.group || "全市场"}</small></div></div>
        <div class="scan-score"><strong>${Number(result.score).toFixed(1)}</strong><small>相似度</small></div>
        <div class="scan-phase"><span class="phase-dot ${result.phase === "趋势偏强" || result.phase === "当前候选" || result.phase === "加速上行" ? "up" : result.phase === "回撤观察" ? "down" : "flat"}"></span>${result.phase || "结构相近"}</div>
        <div class="scan-age">${Number(result.match_age_bars) === 0 ? "当前" : `${result.match_age_bars} 根`}<small>${Number(result.match_age_bars) === 0 ? "最新窗口" : "距今"}</small></div>
        <div class="scan-history">${scanHistoryText(result)}<small>历史相似样本</small></div>
        <div class="scan-actions"><button class="watch-toggle" type="button" data-watch-code="${result.code}" aria-label="${isWatched(result.code) ? "移出观察列表" : "加入观察列表"}" title="${isWatched(result.code) ? "移出观察列表" : "加入观察列表"}">${isWatched(result.code) ? "★" : "☆"}</button><button class="row-open-button" type="button" data-open-code="${result.code}">查看</button></div>
      </div>
    `).join("");
    $$('[data-watch-code]').forEach((button) => button.addEventListener("click", (event) => toggleWatchlist(button.dataset.watchCode, event)));
    $$('[data-open-code]').forEach((button) => button.addEventListener("click", () => openResultInSearch(button.dataset.openCode)));
  }

  async function runMarketScan() {
    if (state.scanLoading) return;
    const queryPoints = sampleSketchPath(state.points);
    if (queryPoints.length < 2) {
      state.scanResults = [];
      state.scanTotal = 0;
      renderScanView();
      return;
    }
    state.scanLoading = true;
    renderScanView();
    try {
      const response = await fetch("/api/match", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ points: queryPoints, lookback: state.lookback, group: state.scanMarket, mode: state.scanMode, recent_days: state.recentDays, limit: 80, compact: false }) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "scan failed");
      state.scanResults = payload.results || [];
      state.scanTotal = payload.count || state.scanResults.length;
      $("#scan-data-note").textContent = `数据日期 ${formatDate(payload.overview.latest_date)}`;
      $("#scan-disclaimer-date").textContent = formatDate(payload.overview.latest_date);
    } catch (error) {
      state.scanResults = [];
      state.scanTotal = 0;
    } finally {
      state.scanLoading = false;
      renderScanView();
    }
  }

  function drawQuoteChart(canvas, path, positive) {
    const context = canvas.getContext("2d");
    const { width, height } = resizeCanvas(canvas, context);
    context.clearRect(0, 0, width, height);
    const values = path && path.length ? path : [.45, .48, .46, .51, .55, .53, .59, .62];
    context.beginPath();
    values.forEach((value, index) => {
      const x = 4 + ((width - 8) * index) / Math.max(1, values.length - 1);
      const y = 4 + (1 - clamp(Number(value))) * (height - 8);
      if (!index) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.strokeStyle = positive ? "#d6b382" : "#7db7a5";
    context.lineWidth = 1.6;
    context.lineJoin = "round";
    context.lineCap = "round";
    context.stroke();
  }

  async function loadWatchlist() {
    $("#watchlist-summary-count").textContent = `${state.watchlist.length} 个标的`;
    if (!state.watchlist.length) {
      $("#watchlist-empty").hidden = false;
      $("#watchlist-grid").innerHTML = "";
      return;
    }
    $("#watchlist-empty").hidden = true;
    $("#watchlist-grid").innerHTML = '<div class="watchlist-loading">正在刷新观察列表…</div>';
    try {
      const response = await fetch(`/api/quotes?codes=${encodeURIComponent(state.watchlist.join(","))}`);
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "quotes failed");
      state.watchQuotes = payload.items || [];
      const overview = payload.overview || {};
      $("#watchlist-data-note").textContent = `数据日期 ${formatDate(overview.latest_date)}`;
      $("#watchlist-summary-count").textContent = `${state.watchlist.length} 个标的`;
      renderWatchlist();
    } catch (error) {
      $("#watchlist-grid").innerHTML = '<div class="watchlist-loading">观察列表刷新失败，请稍后重试。</div>';
    }
  }

  function renderWatchlist() {
    const grid = $("#watchlist-grid");
    if (!state.watchQuotes.length) {
      grid.innerHTML = '<div class="watchlist-loading">列表中的标的暂时没有行情数据。</div>';
      return;
    }
    grid.innerHTML = state.watchQuotes.map((quote) => {
      const matched = state.results.find((result) => result.code === quote.code) || state.scanResults.find((result) => result.code === quote.code);
      const score = matched ? `${Number(matched.score).toFixed(1)} 分` : "未扫描";
      return `
        <article class="watch-card" data-code="${quote.code}">
          <div class="watch-card-head"><div class="watch-symbol"><strong>${quote.code}</strong><small>${quote.exchange} · ${quote.group}</small></div><button class="watch-toggle" type="button" data-watch-code="${quote.code}" aria-label="移出观察列表" title="移出观察列表">★</button></div>
          <div class="watch-card-meta"><span>最新 ${formatDate(quote.latest_date)}</span><span class="watch-trend">${quote.trend}</span></div>
          <canvas class="watch-chart" data-path="${encodeURIComponent(JSON.stringify(quote.path))}" data-positive="${Number(quote.return_20d) >= 0}"></canvas>
          <div class="watch-price-row"><strong>${Number(quote.latest_price).toFixed(2)}</strong><span class="${Number(quote.day_change) >= 0 ? "positive" : "negative"}">${formatPercent(quote.day_change)}</span></div>
          <div class="watch-metric-grid"><div><span>5 日</span><strong class="${Number(quote.return_5d) >= 0 ? "positive" : "negative"}">${formatPercent(quote.return_5d)}</strong></div><div><span>20 日</span><strong class="${Number(quote.return_20d) >= 0 ? "positive" : "negative"}">${formatPercent(quote.return_20d)}</strong></div><div><span>量能</span><strong>${Number(quote.volume_ratio).toFixed(2)}×</strong></div></div>
          <div class="watch-card-footer"><span>形态匹配</span><strong>${score}</strong><button class="row-open-button" data-open-code="${quote.code}" type="button">查看形态</button></div>
        </article>
      `;
    }).join("");
    $$('[data-watch-code]').forEach((button) => button.addEventListener("click", (event) => toggleWatchlist(button.dataset.watchCode, event)));
    $$('[data-open-code]').forEach((button) => button.addEventListener("click", () => openResultInSearch(button.dataset.openCode)));
    $$(".watch-chart").forEach((canvas) => drawQuoteChart(canvas, JSON.parse(decodeURIComponent(canvas.dataset.path)), canvas.dataset.positive === "true"));
  }

  function openResultInSearch(code) {
    setActiveView("search");
    const index = state.results.findIndex((result) => result.code === code);
    if (index >= 0) {
      state.selectedIndex = index;
      renderResults();
      return;
    }
    const scanIndex = state.scanResults.findIndex((result) => result.code === code);
    if (scanIndex >= 0) {
      const scanResult = state.scanResults[scanIndex];
      state.results = [scanResult, ...state.results.filter((result) => result.code !== code)].slice(0, 24);
      state.selectedIndex = 0;
      renderResults();
    }
  }

  function setLoading(loading) {
    state.loading = loading;
    $("#search-button").disabled = loading;
    $("#search-button span:nth-child(2)").textContent = loading ? "正在扫描…" : "搜索相似形态";
    $("#match-count").textContent = loading ? `正在扫描${modeLabel()}…` : $("#match-count").textContent;
  }

  async function runSearch() {
    if (state.searchDebounceTimer) {
      window.clearTimeout(state.searchDebounceTimer);
      state.searchDebounceTimer = null;
    }
    if (state.loading) {
      state.searchPending = true;
      return;
    }
    const queryPoints = sampleSketchPath(state.points);
    if (queryPoints.length < 2) {
      $("#match-count").textContent = "请先绘制至少两个点";
      $("#scan-time").textContent = "—";
      return;
    }
    setLoading(true);
    try {
      const response = await fetch("/api/match", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ points: queryPoints, lookback: state.lookback, group: state.market, mode: state.searchMode, recent_days: state.recentDays }) });
      const payload = await response.json();
      if (!response.ok || !payload.ok || !payload.results || !payload.results.length) throw new Error(payload.error || "no results");
      state.results = payload.results;
      state.overview = payload.overview || state.overview;
      state.fallback = false;
      $("#scan-time").textContent = `${payload.elapsed_ms} ms`;
      $("#match-count").textContent = `${payload.count.toLocaleString()} 个${modeLabel()}`;
    } catch (error) {
      state.results = createFallbackResults();
      state.fallback = true;
      $("#scan-time").textContent = "本地示例";
      $("#match-count").textContent = `示例结果 · 8 个${modeLabel()}`;
    } finally {
      state.selectedIndex = 0;
      setLoading(false);
      renderResults();
      if (state.searchPending) {
        state.searchPending = false;
        window.setTimeout(runSearch, 0);
      }
    }
  }

  function drawMainChart(result) {
    const { width, height } = resizeCanvas(mainCanvas, mainContext);
    mainContext.clearRect(0, 0, width, height);
    const candles = result && result.candles ? result.candles : [];
    if (!candles.length) return;
    const pad = { left: 40, right: 12, top: 22, bottom: 27 };
    const plotWidth = Math.max(1, width - pad.left - pad.right);
    const plotHeight = Math.max(1, height - pad.top - pad.bottom);
    const highs = candles.map((candle) => Number(candle.high));
    const lows = candles.map((candle) => Number(candle.low));
    const high = Math.max(...highs);
    const low = Math.min(...lows);
    const span = Math.max(high - low, 0.01);
    const xAt = (index) => pad.left + ((index + .5) / candles.length) * plotWidth;
    const yAt = (value) => pad.top + (1 - (value - low) / span) * plotHeight;

    mainContext.strokeStyle = "rgba(218,225,217,.07)";
    mainContext.lineWidth = 1;
    for (let row = 0; row <= 4; row += 1) {
      const y = pad.top + (plotHeight * row) / 4;
      mainContext.beginPath(); mainContext.moveTo(pad.left, y); mainContext.lineTo(width - pad.right, y); mainContext.stroke();
      mainContext.fillStyle = "#617176"; mainContext.font = "9px Segoe UI"; mainContext.textAlign = "right"; mainContext.fillText((high - (span * row) / 4).toFixed(2), pad.left - 7, y + 3);
    }
    const candleWidth = Math.max(2, Math.min(10, plotWidth / candles.length * .54));
    const matchStart = candles.findIndex((candle) => candle.match);
    const matchEnd = matchStart < 0 ? matchStart : candles.slice(matchStart).findIndex((candle) => !candle.match);
    const matchEndIndex = matchStart < 0 ? 0 : matchEnd < 0 ? candles.length : matchStart + matchEnd;
    const matchX = matchStart < 0 ? pad.left : pad.left + (matchStart / candles.length) * plotWidth;
    const matchWidth = matchStart < 0 ? 0 : (matchEndIndex - matchStart) / candles.length * plotWidth;
    mainContext.fillStyle = "rgba(214,179,130,.045)";
    mainContext.fillRect(matchX, pad.top, matchWidth, plotHeight);
    mainContext.strokeStyle = "rgba(214,179,130,.52)";
    mainContext.setLineDash([3, 4]);
    mainContext.beginPath(); mainContext.moveTo(matchX + matchWidth, pad.top); mainContext.lineTo(matchX + matchWidth, height - pad.bottom); mainContext.stroke(); mainContext.setLineDash([]);

    mainContext.beginPath();
    candles.forEach((candle, index) => {
      const x = xAt(index); const y = yAt(Number(candle.close));
      if (index === 0) mainContext.moveTo(x, y); else mainContext.lineTo(x, y);
    });
    mainContext.strokeStyle = "rgba(232,236,229,.25)"; mainContext.lineWidth = 1; mainContext.stroke();

    candles.forEach((candle, index) => {
      const x = xAt(index); const openY = yAt(Number(candle.open)); const closeY = yAt(Number(candle.close));
      const highY = yAt(Number(candle.high)); const lowY = yAt(Number(candle.low)); const rising = Number(candle.close) >= Number(candle.open);
      const color = rising ? "#e4776e" : "#4ab08f";
      mainContext.strokeStyle = color; mainContext.fillStyle = rising ? "#e4776e" : "#4ab08f"; mainContext.lineWidth = 1;
      mainContext.beginPath(); mainContext.moveTo(x, highY); mainContext.lineTo(x, lowY); mainContext.stroke();
      const bodyTop = Math.min(openY, closeY); const bodyHeight = Math.max(1, Math.abs(closeY - openY));
      if (rising) mainContext.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
      else { mainContext.strokeRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight); }
      if (index === 0 || index === candles.length - 1 || index === Math.floor(candles.length * .5)) {
        mainContext.fillStyle = "#637176"; mainContext.font = "9px Segoe UI"; mainContext.textAlign = index === 0 ? "left" : index === candles.length - 1 ? "right" : "center"; mainContext.fillText(formatDate(candle.date), x, height - 9);
      }
    });
  }

  function drawMiniChart(canvas, result) {
    const context = canvas.getContext("2d");
    const { width, height } = resizeCanvas(canvas, context);
    context.clearRect(0, 0, width, height);
    const path = (result && result.pattern) || DEFAULT_POINTS;
    const padding = 4;
    context.beginPath();
    path.forEach((value, index) => {
      const x = padding + ((width - padding * 2) * index) / Math.max(1, path.length - 1);
      const y = padding + (1 - clamp(Number(value))) * (height - padding * 2);
      if (!index) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.strokeStyle = result && Number(result.forward_return) >= 0 ? "#d6b382" : "#7db7a5";
    context.lineWidth = 1.4; context.lineJoin = "round"; context.lineCap = "round"; context.stroke();
  }

  function selectedResult() { return state.results[state.selectedIndex] || state.results[0] || null; }

  function renderInsight(result) {
    if (!result) {
      $("#selected-code").textContent = "—";
      $("#selected-exchange").textContent = "—";
      $("#selected-range").textContent = "—";
      $("#score-value").textContent = "—";
      $("#score-ring").style.setProperty("--score", 0);
      $("#score-title").textContent = "等待扫描";
      $("#score-subtitle").textContent = "选择一个结果查看结构特征";
      $("#forward-label").textContent = "历史相似样本";
      $("#forward-return").textContent = "—";
      $("#forward-return").className = "";
      $("#volume-ratio").textContent = "—";
      $("#latest-price").textContent = "—";
      $("#insight-callout p").textContent = "暂未找到匹配结果，请调整曲线或匹配窗口。";
      $("#chart-footer-left").textContent = "—";
      $("#chart-footer-right").textContent = "点击下方结果查看其它相似区间";
      return;
    }
    const isHistory = state.searchMode === "history";
    const stats = result.history_stats || {};
    $("#selected-code").textContent = codeLabel(result.code);
    $("#selected-exchange").textContent = result.exchange || "—";
    const ageText = !isHistory && Number(result.match_age_bars) > 0 ? ` · 距今 ${result.match_age_bars} 根` : "";
    $("#selected-range").textContent = `${formatDate(result.match_start)} — ${formatDate(result.match_end)}${ageText}`;
    $("#score-value").textContent = Number(result.score).toFixed(1);
    $("#score-ring").style.setProperty("--score", clamp(Number(result.score), 0, 100));
    $("#score-title").textContent = result.phase || "结构相近";
    $("#score-subtitle").textContent = state.fallback ? "界面示例结果" : `${modeLabel()} · 仅使用已完成交易数据`;
    const forward = $("#forward-return");
    const forwardLabel = $("#forward-label");
    if (isHistory) {
      forwardLabel.textContent = "形态后 15 日";
      forward.textContent = formatPercent(result.forward_return);
      forward.className = Number(result.forward_return) >= 0 ? "positive" : "negative";
    } else {
      forwardLabel.textContent = "历史相似上涨率";
      forward.textContent = stats.hit_rate === null || stats.hit_rate === undefined ? "—" : `${Number(stats.hit_rate).toFixed(1)}%`;
      forward.className = Number(stats.hit_rate) >= 50 ? "positive" : "negative";
    }
    $("#volume-ratio").textContent = result.volume_ratio ? `${Number(result.volume_ratio).toFixed(2)} ×` : "—";
    $("#latest-price").textContent = result.latest_price ? Number(result.latest_price).toFixed(2) : "—";
    if (isHistory) {
      $("#insight-callout p").textContent = Number(result.forward_return) >= 4.5 ? "相似区间之后，历史样本更常见放量上行，适合继续观察突破确认。" : Number(result.forward_return) <= -3.5 ? "相似区间之后，历史样本偏向回撤，注意结构失效与风险收敛。" : "相似区间之后，历史样本的方向分歧较大，建议结合量价与当前位置判断。";
    } else {
      const median = stats.median_return === null || stats.median_return === undefined ? "—" : formatPercent(stats.median_return);
      const sampleCount = stats.count || 0;
      $("#insight-callout p").textContent = sampleCount ? `当前结果没有未来收益。历史相似样本 ${sampleCount} 次，未来 15 日收益中位数 ${median}，仅作风险参考。` : "当前结果没有未来收益，暂未找到足够的历史相似样本用于统计。";
    }
    $("#chart-footer-left").textContent = `${result.code} · ${result.latest_date ? `最新 ${formatDate(result.latest_date)}` : "历史样本"}`;
    $("#chart-footer-right").textContent = isHistory ? "历史匹配区间 · 点击下方结果查看其它样本" : `${modeLabel()} · 点击下方结果查看其它候选`;
    drawMainChart(result);
  }

  function renderResults() {
    const list = $("#match-list");
    if (!state.results.length) {
      list.innerHTML = '<div class="empty-card">暂未找到足够相似的形态，请调整曲线或匹配窗口。</div>';
      renderInsight(null);
      drawMainChart(null);
      return;
    }
    list.innerHTML = state.results.slice(0, 12).map((result, index) => `
      <div class="match-card${index === state.selectedIndex ? " selected" : ""}" role="button" tabindex="0" data-index="${index}">
        <span class="rank">${String(index + 1).padStart(2, "0")}</span>
        <span class="stock-code"><strong>${codeLabel(result.code)}</strong><small>${result.exchange || "A 股"} · ${result.group || "全市场"}</small></span>
        <canvas class="mini-chart" data-index="${index}" aria-label="${codeLabel(result.code)} 形态缩略图"></canvas>
        <span class="card-score">${Number(result.score).toFixed(1)}<small>相似度</small></span>
        <span class="card-return${state.searchMode === "history" ? (Number(result.forward_return) >= 0 ? " positive" : " negative") : " current-card-value"}">${state.searchMode === "history" ? formatPercent(result.forward_return) : Number(result.match_age_bars) === 0 ? "当前" : `${result.match_age_bars} 根前`}<small>${state.searchMode === "history" ? "后续 15 日" : state.searchMode === "recent" ? "距今" : "最新窗口"}</small></span>
        <button class="watch-toggle" type="button" data-watch-code="${result.code}" aria-label="${isWatched(result.code) ? "移出观察列表" : "加入观察列表"}" title="${isWatched(result.code) ? "移出观察列表" : "加入观察列表"}">${isWatched(result.code) ? "★" : "☆"}</button>
      </div>
    `).join("");
    $$(".match-card").forEach((card) => {
      const select = () => { state.selectedIndex = Number(card.dataset.index); renderResults(); };
      card.addEventListener("click", select);
      card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
    });
    $$('[data-watch-code]').forEach((button) => button.addEventListener("click", (event) => toggleWatchlist(button.dataset.watchCode, event)));
    $$(".mini-chart").forEach((canvas) => drawMiniChart(canvas, state.results[Number(canvas.dataset.index)]));
    renderInsight(selectedResult());
  }

  async function loadOverview() {
    try {
      const response = await fetch("/api/overview");
      const data = await response.json();
      if (!response.ok || !data.ok) return;
      state.overview = data;
      $("#heading-date").textContent = formatDate(data.latest_date);
      $("#scan-data-note").textContent = `数据日期 ${formatDate(data.latest_date)}`;
      $("#watchlist-data-note").textContent = `数据日期 ${formatDate(data.latest_date)}`;
      $("#scan-disclaimer-date").textContent = formatDate(data.latest_date);
      const lagText = data.data_lag_days === null || data.data_lag_days === undefined ? "数据新鲜度未知" : data.data_fresh ? "数据新鲜" : `数据滞后 ${data.data_lag_days} 天`;
      $("#data-freshness").textContent = lagText;
      $("#data-freshness").classList.toggle("fresh", Boolean(data.data_fresh));
      $("#footer-date").textContent = `数据日期 ${formatDate(data.latest_date)} · ${lagText}`;
      $("#count-all").textContent = data.stock_count.toLocaleString();
      $("#count-board").textContent = (data.groups.主板 || 0).toLocaleString();
      $("#count-growth").textContent = (data.groups.成长 || 0).toLocaleString();
      $("#count-bj").textContent = (data.groups.北交所 || 0).toLocaleString();
    } catch (error) {
      $("#heading-date").textContent = "本地示例";
      $("#footer-date").textContent = "等待本地服务";
      $("#data-freshness").textContent = "等待数据状态";
    }
  }

  function renderUpdateStatus(payload) {
    const job = payload.job || {};
    const status = job.status || "idle";
    const statusPanel = $("#data-update-status");
    const labels = { idle: "准备就绪", running: "正在更新行情", success: "更新完成", error: "更新失败" };
    statusPanel.classList.remove("running", "success", "error");
    if (["running", "success", "error"].includes(status)) statusPanel.classList.add(status);
    $("#update-status-text").textContent = labels[status] || status;
    const noLocalData = !payload.overview || !payload.overview.latest_date;
    $("#update-status-detail").textContent = job.detail || (noLocalData ? "本地暂无行情，请填写开始日期" : "默认从本地最新日期开始");
    dataUpdateLog.textContent = job.log && job.log.length ? job.log.join("\n") : "等待更新任务…";
    dataUpdateLog.scrollTop = dataUpdateLog.scrollHeight;
    dataUpdateRunButton.disabled = status === "running";
    dataUpdateRunButton.querySelector("span:nth-child(2)").textContent = status === "running" ? "更新中…" : "开始更新";
    state.updateStatus = status;
    if (payload.overview && payload.overview.latest_date) {
      $("#heading-date").textContent = formatDate(payload.overview.latest_date);
      $("#scan-data-note").textContent = `数据日期 ${formatDate(payload.overview.latest_date)}`;
      $("#watchlist-data-note").textContent = `数据日期 ${formatDate(payload.overview.latest_date)}`;
      $("#scan-disclaimer-date").textContent = formatDate(payload.overview.latest_date);
    }
  }

  async function refreshUpdateStatus() {
    try {
      const response = await fetch("/api/update-status");
      const payload = await response.json();
      const previous = state.updateStatus;
      renderUpdateStatus(payload);
      if (previous === "running" && payload.job.status === "success") {
        await loadOverview();
        state.scanResults = [];
        state.scanTotal = 0;
        if (state.activeView === "search" && !state.loading) runSearch();
        if (state.activeView === "scan") runMarketScan();
        if (state.activeView === "watchlist") loadWatchlist();
      }
      if (payload.job.status === "running") {
        if (state.updatePollTimer) window.clearTimeout(state.updatePollTimer);
        state.updatePollTimer = window.setTimeout(refreshUpdateStatus, 1200);
      }
    } catch (error) {
      $("#update-status-text").textContent = "更新状态不可用";
      $("#update-status-detail").textContent = "请确认本地服务仍在运行";
    }
  }

  async function startDataUpdate() {
    if (dataUpdateRunButton.disabled) return;
    const startDate = $("#update-start-date").value;
    const endDate = $("#update-end-date").value;
    const updateToken = $("#update-token").value.trim();
    dataUpdateRunButton.disabled = true;
    try {
      const headers = { "Content-Type": "application/json" };
      if (updateToken) headers.Authorization = `Bearer ${updateToken}`;
      const response = await fetch("/api/update", { method: "POST", headers, body: JSON.stringify({ start_date: startDate || null, end_date: endDate || null }) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "更新任务启动失败");
      renderUpdateStatus({ job: payload.job });
      refreshUpdateStatus();
    } catch (error) {
      renderUpdateStatus({ job: { status: "error", detail: error.message, log: [error.message] } });
    }
  }

  function toggleDataUpdatePanel(open) {
    dataUpdatePanel.hidden = !open;
    if (open) {
      if (!$("#update-end-date").value) $("#update-end-date").value = new Date().toISOString().slice(0, 10);
      refreshUpdateStatus();
    }
  }

  function setMarket(market) {
    state.market = market;
    $$("[data-market]").forEach((element) => element.classList.toggle("active", element.dataset.market === market));
    if (state.activeView === "scan") {
      state.scanMarket = market;
      $$('[data-scan-market]').forEach((element) => element.classList.toggle("active", element.dataset.scanMarket === market));
      runMarketScan();
    } else if (state.activeView === "search") {
      runSearch();
    }
  }

  $$('[data-view]').forEach((button) => button.addEventListener("click", () => setActiveView(button.dataset.view)));
  $("#data-update-trigger").addEventListener("click", () => {
    if (state.activeView !== "search") setActiveView("search");
    toggleDataUpdatePanel(dataUpdatePanel.hidden);
  });
  $("#data-update-close").addEventListener("click", () => toggleDataUpdatePanel(false));
  $("#data-update-run").addEventListener("click", startDataUpdate);
  $("#sidebar-data-update").addEventListener("click", () => {
    setActiveView("search");
    toggleDataUpdatePanel(true);
    dataUpdatePanel.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $$("[data-market]").forEach((element) => element.addEventListener("click", () => setMarket(element.dataset.market)));
  searchModeButtons.forEach((button) => button.addEventListener("click", () => setSearchMode(button.dataset.mode)));
  $$('[data-recent-days]').forEach((button) => button.addEventListener("click", () => {
    state.recentDays = Number(button.dataset.recentDays);
    updateSearchModeControls();
    if (state.searchMode === "recent") runSearch();
  }));
  $$('[data-scan-market]').forEach((button) => button.addEventListener("click", () => {
    state.scanMarket = button.dataset.scanMarket;
    state.market = state.scanMarket;
    $$('[data-market]').forEach((item) => item.classList.toggle("active", item.dataset.market === state.scanMarket));
    $$('[data-scan-market]').forEach((item) => item.classList.toggle("active", item === button));
    runMarketScan();
  }));
  $$('[data-scan-mode]').forEach((button) => button.addEventListener("click", () => {
    state.scanMode = button.dataset.scanMode;
    $$('[data-scan-mode]').forEach((item) => item.classList.toggle("active", item === button));
    runMarketScan();
  }));
  $("#scan-score-select").addEventListener("change", (event) => { state.scanMinScore = Number(event.target.value); renderScanView(); });
  $("#scan-phase-select").addEventListener("change", (event) => { state.scanPhase = event.target.value; renderScanView(); });
  $("#scan-run-button").addEventListener("click", runMarketScan);
  $("#watchlist-refresh").addEventListener("click", loadWatchlist);
  $("#watchlist-scan-button").addEventListener("click", () => { setActiveView("scan"); runMarketScan(); });
  $("#watchlist-empty-search").addEventListener("click", () => setActiveView("search"));
  $("#watchlist-clear-button").addEventListener("click", () => {
    if (!state.watchlist.length) return;
    if (window.confirm("确认清空观察列表吗？")) {
      saveWatchlist([]);
      loadWatchlist();
    }
  });
  $$("[data-lookback]").forEach((element) => element.addEventListener("click", () => {
    const value = element.dataset.lookback === "screenshot" ? state.uploadCandleCount : Number(element.dataset.lookback);
    if (!Number.isFinite(value)) return;
    state.lookback = value;
    updateLookbackButtons();
    runSearch();
  }));
  $("#load-example").addEventListener("click", () => {
    setInputMode("draw");
    state.previousPoints = cloneSketchPath(state.points);
    state.drawPoints = makeSketchPath(DEFAULT_POINTS);
    state.points = makeSketchPath(DEFAULT_POINTS);
    if (state.lookback === state.uploadCandleCount) state.lookback = 40;
    updateLookbackButtons();
    setCanvasHint("在这里画出你的走势", "✎");
    drawSketch();
  });
  $("#clear-drawing").addEventListener("click", () => {
    state.previousPoints = cloneSketchPath(state.points);
    state.points = [];
    if (state.mode === "draw") state.drawPoints = [];
    if (state.mode === "upload") {
      state.uploadImage = null;
      state.uploadFile = null;
      state.uploadPoints = [];
      state.uploadCrop = null;
      state.uploadDrag = null;
      state.uploadCandleCount = null;
      state.lookback = 40;
      uploadInput.value = "";
      uploadFileName.textContent = "尚未选择图片";
      uploadFileStatus.textContent = "支持 PNG / JPG / WEBP，图片只在本地处理";
    }
    $("#match-count").textContent = "等待输入";
    updateInputTabs();
    updateLookbackButtons();
    drawSketch();
  });
  $("#search-button").addEventListener("click", runSearch);
  $("#refresh-button").addEventListener("click", runSearch);

  mainCanvas.addEventListener("mousemove", (event) => {
    const result = selectedResult();
    if (!result || !result.candles || !result.candles.length) return;
    const rect = mainCanvas.getBoundingClientRect();
    const index = Math.max(0, Math.min(result.candles.length - 1, Math.floor(((event.clientX - rect.left - 40) / Math.max(1, rect.width - 52)) * result.candles.length)));
    const candle = result.candles[index];
    if (!candle) return;
    const tooltip = $("#chart-tooltip");
    tooltip.innerHTML = `<strong>${formatDate(candle.date)}</strong><br>开 ${Number(candle.open).toFixed(2)} · 收 ${Number(candle.close).toFixed(2)}<br>高 ${Number(candle.high).toFixed(2)} · 低 ${Number(candle.low).toFixed(2)}`;
    tooltip.style.left = `${Math.min(rect.width - 126, Math.max(8, event.clientX - rect.left + 9))}px`;
    tooltip.style.top = `${Math.max(10, event.clientY - rect.top - 72)}px`;
    tooltip.classList.add("visible");
  });
  mainCanvas.addEventListener("mouseleave", () => $("#chart-tooltip").classList.remove("visible"));

  const resizeObserver = new ResizeObserver(() => { drawSketch(); renderInsight(selectedResult()); });
  resizeObserver.observe(sketchCanvas); resizeObserver.observe(mainCanvas);
  window.addEventListener("resize", () => { drawSketch(); renderInsight(selectedResult()); });

  state.results = createFallbackResults();
  $("#watchlist-count").textContent = state.watchlist.length;
  updateViewNavigation();
  updateSearchModeControls();
  drawSketch();
  renderResults();
  loadOverview();
  window.setTimeout(runSearch, 260);
})();
