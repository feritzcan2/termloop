let overlayShown = false;
const overlay = document.getElementById("overlay");

function setOverlay(shown) {
  overlayShown = shown;
  overlay.style.display = shown ? "flex" : "none";
}

document.getElementById("toggle").addEventListener("click", () => {
  setOverlay(!overlayShown);
  window.spike.toggleOverlay(overlayShown);
});
document.getElementById("focus0").addEventListener("click", () => window.spike.focusSurface(0));
document.getElementById("focus1").addEventListener("click", () => window.spike.focusSurface(1));
window.spike.onOverlay(setOverlay);
