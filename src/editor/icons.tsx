// 화면설계 목업(docs/mockups/mvp.html)의 아이콘을 옮긴 것. 아이콘 라이브러리는 사용자 결정 대기라 직접 둔다.
const PATHS = {
  text: <path d="M5 6h14M12 6v13" />,
  list: (
    <>
      <path d="M10 6h10M10 12h10M10 18h10" />
      <circle cx="5" cy="6" r="1" />
      <circle cx="5" cy="12" r="1" />
      <circle cx="5" cy="18" r="1" />
    </>
  ),
  olist: <path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1v5M4 14.5a1.5 1.5 0 1 1 2.5 1L4 18.5h3" />,
  todo: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="M8 12l3 3 5-6" />
    </>
  ),
  code: <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />,
  table: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M3.5 15h17M10 4.5v15" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="M20.5 16l-5-5L6 19.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  grip: (
    <>
      <circle cx="9" cy="6" r="1.1" />
      <circle cx="15" cy="6" r="1.1" />
      <circle cx="9" cy="12" r="1.1" />
      <circle cx="15" cy="12" r="1.1" />
      <circle cx="9" cy="18" r="1.1" />
      <circle cx="15" cy="18" r="1.1" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
