let navigationQuietUntil = 0;
let navigationSourceUrl = "";
function navigationWorkPaused() {
  const now = performance.now();
  if (now >= navigationQuietUntil) return false;

  // SPA 라우터가 URL을 바꾼 뒤에는 새 화면 초기화에 필요한 짧은 여유만 둔다.
  if (navigationSourceUrl && location.href !== navigationSourceUrl) {
    navigationSourceUrl = location.href;
    navigationQuietUntil = Math.min(navigationQuietUntil, now + 250);
  }
  return true;
}

// 토스 내부 링크를 누르면 고빈도 화면 갱신을 잠시 멈춰
// React 라우터가 메인 스레드를 바로 사용할 수 있게 한다. 새 탭 링크는 제외한다.
function handleNavigationIntent(event) {
  if (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!anchor || anchor.hasAttribute("download") || (anchor.target && anchor.target !== "_self")) return;
  try {
    const target = new URL(anchor.href, location.href);
    if (target.origin === location.origin && target.href !== location.href) {
      navigationSourceUrl = location.href;
      navigationQuietUntil = performance.now() + 2_000;
    }
  } catch {
    // 브라우저가 해석할 수 없는 링크는 사이트 원래 동작에 맡긴다.
  }
}
// pointerdown 시점부터 잠시 멈추고, 키보드로 링크를 여는 경우는 click 이벤트로 보완한다.
document.addEventListener("pointerdown", handleNavigationIntent, true);
document.addEventListener("click", handleNavigationIntent, true);
