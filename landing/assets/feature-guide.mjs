export function matchesFeature(text, query) {
  const words = query.toLocaleLowerCase('en-US').trim().split(/\s+/).filter(Boolean);
  const haystack = text.toLocaleLowerCase('en-US');
  return words.every(word => haystack.includes(word));
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
  const stories = [...document.querySelectorAll('.feature-story')];
  if (!stories.length) return;
  const videos = stories.map(story => story.querySelector('video'));
  const search = document.querySelector('#feature-search');
  const speed = document.querySelector('#video-speed');
  const autoplay = document.querySelector('#demo-autoplay');
  const clear = document.querySelector('#clear-feature-search');
  const count = document.querySelector('#feature-count');
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
    const label = story.querySelector('.feature-kicker').textContent;
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
      for (const entry of entries) rows.find(row => row.video === entry.target).ratio = entry.isIntersecting ? entry.intersectionRatio : 0;
      updateAutoplay();
    }, { threshold: [0, .3, .55, .8, 1] });
    videos.forEach(video => observer.observe(video));
  }
  const navigation = [...document.querySelectorAll('.feature-nav a')];
  const applyFilter = () => {
    for (const row of rows) {
      row.hidden = !matchesFeature(row.story.textContent, search.value);
      row.story.hidden = row.hidden;
      if (row.hidden) pauseForPolicy(row.video);
    }
    navigation.forEach(link => { link.hidden = document.querySelector(link.getAttribute('href')).hidden; });
    document.querySelectorAll('.feature-group').forEach(group => { group.hidden = ![...group.querySelectorAll('.feature-story')].some(story => !story.hidden); });
    document.querySelectorAll('[data-nav-group]').forEach(group => { group.hidden = ![...group.querySelectorAll('a')].some(link => !link.hidden); });
    const visible = rows.filter(row => !row.hidden).length;
    count.textContent = `${visible} ${visible === 1 ? 'feature' : 'features'}${search.value.trim() ? ` matching “${search.value.trim()}”` : ''}`;
    document.querySelector('#feature-empty').hidden = visible !== 0;
    clear.hidden = search.value.length === 0;
    updateAutoplay();
    updateNavigation();
  };
  const updateNavigation = () => {
    const visible = stories.filter(story => !story.hidden);
    const focusLine = Math.min(window.innerHeight * .35, 320);
    let active = visible[0];
    for (const story of visible) {
      if (story.getBoundingClientRect().top > focusLine) break;
      active = story;
    }
    navigation.forEach(link => {
      const selected = link.getAttribute('href') === `#${active?.id}`;
      link.classList.toggle('active', selected);
      if (selected) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  };
  search.addEventListener('input', applyFilter);
  clear.addEventListener('click', () => { search.value = ''; applyFilter(); search.focus(); });
  let frame;
  window.addEventListener('scroll', () => {
    if (frame) return;
    frame = window.requestAnimationFrame(() => { frame = undefined; updateNavigation(); });
  }, { passive: true });
  window.addEventListener('resize', updateNavigation);
  window.addEventListener('hashchange', () => {
    let id;
    try { id = decodeURIComponent(window.location.hash.slice(1)); } catch { return; }
    const target = stories.find(story => story.id === id);
    if (target?.hidden) { search.value = ''; applyFilter(); target.scrollIntoView(); }
    updateNavigation();
  });
  document.addEventListener('visibilitychange', updateAutoplay);
  motion.addEventListener('change', () => {
    if (motion.matches) { autoplay.checked = false; videos.forEach(pauseForPolicy); }
    updateAutoplay();
  });
  applySpeed();
  applyFilter();
}

if (typeof document !== 'undefined') initializeGuide(document, window);
