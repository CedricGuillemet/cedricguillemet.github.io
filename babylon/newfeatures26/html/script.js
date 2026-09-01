const slides = [...document.querySelectorAll(".slide")];
const navLinks = [...document.querySelectorAll(".rail a")];
const counter = document.querySelector("#current-slide");

function setActiveSlide(slide) {
  const index = Number(slide.dataset.index);
  counter.textContent = String(index).padStart(2, "0");
  navLinks.forEach((link, linkIndex) => {
    const isActive = linkIndex === index - 1;
    link.classList.toggle("active", isActive);
    if (isActive) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });
  if (window.location.hash !== `#${slide.id}`) {
    history.replaceState(null, "", `#${slide.id}`);
  }
}

const observer = new IntersectionObserver(
  (entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible) setActiveSlide(visible.target);
  },
  { threshold: [0.45, 0.7] }
);

slides.forEach((slide) => observer.observe(slide));
const initialSlide = slides.find((slide) => `#${slide.id}` === window.location.hash) ?? slides[0];
setActiveSlide(initialSlide);
if (initialSlide !== slides[0]) {
  requestAnimationFrame(() => initialSlide.scrollIntoView());
}

document.addEventListener("keydown", (event) => {
  if (!["ArrowDown", "ArrowRight", "PageDown", "ArrowUp", "ArrowLeft", "PageUp", "Home", "End"].includes(event.key)) return;

  const currentIndex = Math.max(
    0,
    slides.findIndex((slide) => slide.getBoundingClientRect().top > -window.innerHeight / 2)
  );
  let nextIndex = currentIndex;
  if (["ArrowDown", "ArrowRight", "PageDown"].includes(event.key)) nextIndex++;
  if (["ArrowUp", "ArrowLeft", "PageUp"].includes(event.key)) nextIndex--;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = slides.length - 1;
  nextIndex = Math.max(0, Math.min(slides.length - 1, nextIndex));

  if (nextIndex !== currentIndex || event.key === "Home" || event.key === "End") {
    event.preventDefault();
    slides[nextIndex].scrollIntoView({ behavior: "smooth" });
  }
});

document.querySelector("#fullscreen").addEventListener("click", async () => {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen();
  } else {
    await document.exitFullscreen();
  }
});
