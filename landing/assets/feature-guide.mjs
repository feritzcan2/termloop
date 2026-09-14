// A tall demo can fill the viewport without 55% of the entire video fitting on screen.
export function visibleVideoFraction(entry) {
  if (!entry.isIntersecting) return 0;
  const availableHeight = Math.min(entry.boundingClientRect.height, entry.rootBounds?.height ?? entry.boundingClientRect.height);
  if (availableHeight <= 0 || entry.boundingClientRect.width <= 0) return 0;
  return Math.min(1, entry.intersectionRect.height / availableHeight)
    * Math.min(1, entry.intersectionRect.width / entry.boundingClientRect.width);
}

export function autoplayCandidate(entries, { enabled, reducedMotion, pageHidden }) {
  if (!enabled || reducedMotion || pageHidden) return undefined;
  return entries.filter(entry => !entry.hidden && !entry.manuallyPaused && entry.ratio >= .55)
    .sort((a, b) => b.ratio - a.ratio)[0]?.video;
}

export function validPlaybackRate(value) {
  const rate = Number(value);
  return [.75, 1, 1.25, 1.5].includes(rate) ? rate : 1;
}

export function initializeGuide(document, window) {
  const stories = [...document.querySelectorAll('[data-demo]')];
  if (!stories.length) return;
  const videos = stories.map(story => story.querySelector('video'));
  const speed = document.querySelector('#video-speed');
  const autoplay = document.querySelector('#demo-autoplay');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const rows = stories.map((story, index) => ({ story, video: videos[index], ratio: 0, hidden: false, manuallyPaused: false }));
  const policyPauses = new WeakSet();
  const pauseForPolicy = video => {
    if (video.paused) return;
    policyPauses.add(video);
    video.pause();
  };
  const autoOptions = () => ({ enabled: autoplay.checked, reducedMotion: motion.matches, pageHidden: document.hidden });
  const updateAutoplay = () => {
    const candidate = autoplayCandidate(rows, autoOptions());
    for (const row of rows) {
      if (row.video !== candidate) {
        // Manual playback is stopped only when hidden/offscreen or when auto mode takes over.
        if (autoplay.checked || document.hidden || row.hidden || row.ratio === 0) pauseForPolicy(row.video);
      } else if (candidate.paused) {
        candidate.play().then(() => {
          if (autoplayCandidate(rows, autoOptions()) !== candidate) pauseForPolicy(candidate);
        }).catch(() => {});
      }
    }
  };
  speed.disabled = false;
  autoplay.disabled = !('IntersectionObserver' in window);
  if (motion.matches || autoplay.disabled) autoplay.checked = false;
  const applySpeed = () => videos.forEach(video => { video.playbackRate = validPlaybackRate(speed.value); });
  speed.addEventListener('change', applySpeed);
  autoplay.addEventListener('change', () => {
    if (autoplay.checked) rows.forEach(row => { row.manuallyPaused = false; });
    else videos.forEach(pauseForPolicy);
    updateAutoplay();
  });
  for (const row of rows) {
    const { story, video } = row;
    const play = story.querySelector('[data-play-demo]');
    const expanded = story.querySelector('[data-expand-demo]');
    const label = story.dataset.demoLabel;
    // Keep the native seek controls in fullscreen; inline playback stays unobstructed.
    video.controls = false;
    video.muted = true;
    play.setAttribute('aria-label', `Play ${label} demo`);
    expanded.setAttribute('aria-label', `Fullscreen ${label} demo`);
    play.hidden = false;
    expanded.hidden = false;
    play.addEventListener('click', () => {
      if (video.paused) {
        row.manuallyPaused = false;
        video.play().catch(() => { play.textContent = 'Try playing again'; });
      } else {
        row.manuallyPaused = true;
        video.pause();
      }
    });
    video.addEventListener('play', () => {
      row.manuallyPaused = false;
      videos.filter(other => other !== video).forEach(pauseForPolicy);
      play.textContent = 'Pause demo';
      play.setAttribute('aria-label', `Pause ${label} demo`);
    });
    video.addEventListener('pause', () => {
      if (policyPauses.has(video)) policyPauses.delete(video);
      else row.manuallyPaused = true;
      play.textContent = 'Play demo';
      play.setAttribute('aria-label', `Play ${label} demo`);
    });
    video.addEventListener('ended', () => { row.manuallyPaused = true; });
    video.addEventListener('loadedmetadata', () => {
      story.querySelector('[data-duration]').textContent = `${Math.round(video.duration)} sec`;
      video.playbackRate = validPlaybackRate(speed.value);
    });
    video.addEventListener('error', () => {
      play.textContent = 'Video unavailable';
      story.querySelector('.demo-caption').textContent = 'The video could not load. Use the MP4 download link to open it directly.';
    });
    expanded.addEventListener('click', () => {
      if (video.requestFullscreen) video.requestFullscreen().catch(() => {});
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else window.open(story.querySelector('source[type="video/mp4"]').src, '_blank', 'noopener');
    });
  }
  if ('IntersectionObserver' in window) {
    const observer = new window.IntersectionObserver(entries => {
      for (const entry of entries) rows.find(row => row.video === entry.target).ratio = visibleVideoFraction(entry);
      updateAutoplay();
    }, { threshold: Array.from({ length: 21 }, (_, i) => i / 20) });
    videos.forEach(video => observer.observe(video));
  }
  document.addEventListener('fullscreenchange', () => {
    videos.forEach(video => { video.controls = document.fullscreenElement === video; });
  });
  document.addEventListener('visibilitychange', updateAutoplay);
  motion.addEventListener('change', () => {
    if (motion.matches) { autoplay.checked = false; videos.forEach(pauseForPolicy); }
    updateAutoplay();
  });
  applySpeed();
  updateAutoplay();
}

if (typeof document !== 'undefined') initializeGuide(document, window);
