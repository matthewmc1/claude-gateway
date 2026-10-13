import React from 'react';
import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from './theme';

// The brand mark from assets/brand/logo-mark.svg (light backgrounds) and logo-mark-dark.svg (dark backgrounds), drawn inline so it
// follows the theme. Colours are the brand tokens, not theme tokens: do not recolour. Minimum size 32.
export function Logo({ size = 34 }: { size?: number }) {
  const { t } = useTheme();
  const ink = t.mode === 'dark' ? '#f4f4f1' : '#0d0e11';
  return (
    <Svg width={size} height={size} viewBox="0 0 512 512" accessibilityElementsHidden importantForAccessibility="no" aria-hidden>
      <Path d="M124 416V256a132 132 0 0 1 264 0V416" fill="none" stroke={ink} strokeWidth={56} strokeLinejoin="round" />
      <Path d="M184 336A72 72 0 0 1 328 336" fill="none" stroke={ink} strokeOpacity={0.28} strokeWidth={42} strokeLinecap="round" />
      <Path d="M184 336A72 72 0 0 1 290.69 272.91" fill="none" stroke="#3987e5" strokeWidth={42} strokeLinecap="round" />
      <Circle cx={256} cy={336} r={20} fill={ink} />
    </Svg>
  );
}
