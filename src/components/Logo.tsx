/**
 * prune's logo: a smiling plum (a prune is a dried plum) on a lavender tile,
 * with the name beside it. The mark matches the favicon and touch icon, which
 * are rendered from scripts/brand/prune-mark.svg by scripts/render-icons.mjs.
 */
export function PruneMark(props: { size?: number; class?: string }) {
  return (
    <svg
      class={props.class}
      width={props.size ?? 32}
      height={props.size ?? 32}
      viewBox="0 0 512 512"
      aria-hidden="true"
    >
      <rect width="512" height="512" rx="116" fill="#e4e2fb" />
      <ellipse
        cx="256"
        cy="452"
        rx="128"
        ry="16"
        fill="#7d74ec"
        opacity="0.18"
      />
      <path
        d="M256 168C330 128 424 186 420 290C416 384 344 446 256 446C168 446 96 384 92 290C88 186 182 128 256 168Z"
        fill="#7d74ec"
      />
      <path
        d="M150 238C162 206 186 186 214 180"
        fill="none"
        stroke="#fff"
        stroke-width="16"
        stroke-linecap="round"
        opacity="0.35"
      />
      <path
        d="M256 170C254 138 262 112 280 94"
        fill="none"
        stroke="#3d2f63"
        stroke-width="16"
        stroke-linecap="round"
      />
      <path
        d="M268 122C300 74 370 64 410 86C386 138 320 160 268 122Z"
        fill="#34c759"
      />
      <path
        d="M284 117C322 104 358 96 392 90"
        fill="none"
        stroke="#1f9d45"
        stroke-width="7"
        stroke-linecap="round"
      />
      <ellipse cx="170" cy="334" rx="26" ry="15" fill="#ff9fc0" opacity="0.8" />
      <ellipse cx="342" cy="334" rx="26" ry="15" fill="#ff9fc0" opacity="0.8" />
      <circle cx="206" cy="298" r="19" fill="#1b1640" />
      <circle cx="306" cy="298" r="19" fill="#1b1640" />
      <circle cx="212" cy="291" r="6" fill="#fff" />
      <circle cx="312" cy="291" r="6" fill="#fff" />
      <path
        d="M228 340Q256 368 284 340"
        fill="none"
        stroke="#1b1640"
        stroke-width="13"
        stroke-linecap="round"
      />
    </svg>
  );
}

export function Logo(props: { class?: string; size?: number }) {
  return (
    <span class={`logo ${props.class ?? ""}`}>
      <PruneMark class="logo-mark" size={props.size ?? 36} />
      <span class="logo-name">prune</span>
    </span>
  );
}
