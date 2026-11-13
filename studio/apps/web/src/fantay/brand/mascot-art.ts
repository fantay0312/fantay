// SPDX-License-Identifier: AGPL-3.0-only
// The original folded-paper Fantay drawing (doc/FantayDesign-SVG-package/README.txt), as numbers. The illustrated
// changelog uses this art, and the living mascot cuts its cloth from the silhouette in mascot-sheet.ts.

/** The whole silhouette: the join, round the belly, the tail and the top edge to the raised tip, then the fold's rim. */
export const FRONT_PATH =
  'M 791.635 696.998 C 755.039 745.884 717.403 797.549 661.167 825.667 C 648.981 831.760 635.637 837.175 621.929 838.415 C 550.429 844.884 510.530 781.825 456.398 748.104 C 422.002 726.677 384.033 711.821 344.505 702.992 C 324.917 698.617 279.673 690.378 265.058 678.440 C 260.829 674.985 257.671 669.601 257.671 664.000 C 257.670 635.727 318.810 610.061 339.856 598.357 C 347.439 594.140 355.813 591.135 363.492 586.992 C 385.696 575.012 407.436 561.607 426.476 544.975 C 482.860 495.722 514.636 407.110 595.312 391.824 C 670.034 377.666 748.139 437.620 836.493 418.990 C 858.354 414.380 879.967 405.567 898.376 392.874 C 912.691 383.003 925.440 371.362 938.476 359.975 C 955.245 345.326 972.058 324.593 992.317 314.824 C 998.580 311.804 1007.851 309.086 1014.667 311.757 C 1015.557 312.106 1015.320 313.149 1015.663 313.301 C 1017.778 313.936 1019.738 313.673 1021.774 314.732 C 1034.368 321.277 1041.544 345.114 1045.749 357.752 C 1054.400 383.752 1056.032 413.024 1053.585 440.071 C 1049.462 485.645 1036.381 531.027 1008.882 568.384 C 969.409 622.006 906.164 655.146 845.546 679.052 C 828.104 685.931 809.996 693.257 791.635 696.998 Z';
/** The underside where the raised end shows it: the tip, down the rim to the join, and back up the fold's free edge. */
export const BACK_PATH =
  'M 1015.663 313.301 C 1017.778 313.936 1019.738 313.673 1021.774 314.732 C 1034.368 321.277 1041.544 345.114 1045.749 357.752 C 1054.400 383.752 1056.032 413.024 1053.585 440.071 C 1049.462 485.645 1036.381 531.027 1008.882 568.384 C 969.409 622.006 906.164 655.146 845.546 679.052 C 828.104 685.931 809.996 693.257 791.635 696.998 C 791.735 696.802 791.133 696.821 791.104 696.602 C 791.046 696.171 792.434 694.591 792.697 694.197 C 801.717 680.690 810.023 666.751 818.280 652.781 C 832.953 627.955 845.613 601.981 858.843 576.351 C 868.013 558.583 876.287 540.298 884.675 522.172 C 892.254 505.794 900.373 489.665 907.644 473.148 C 916.261 453.570 925.340 434.245 934.325 414.828 C 950.224 380.471 976.702 324.902 1015.663 313.301 Z';

/** The optical cut for 16–32 px: simpler fold, wider eyes. */
export const BACK_PATH_SMALL =
  'M 973.498 327.998 C 983.276 319.844 1001.081 306.433 1014.667 311.757 C 1015.609 312.126 1015.264 313.112 1015.663 313.301 C 1019.499 315.118 1021.705 313.645 1025.917 317.584 C 1038.127 329.003 1046.599 357.631 1049.814 373.695 C 1056.576 407.485 1055.556 441.612 1048.814 475.305 C 1029.502 571.809 969.418 619.625 885.874 661.380 C 859.600 674.511 820.149 691.188 791.635 696.998 C 791.735 696.802 791.133 696.821 791.104 696.602 C 791.046 696.171 792.434 694.591 792.697 694.197 C 803.330 678.274 813.229 661.814 822.629 645.149 C 845.277 605.004 871.378 553.486 888.573 510.870 C 899.104 484.768 910.348 458.820 919.230 432.081 C 926.916 408.941 933.656 384.414 944.510 362.496 C 950.700 349.996 959.088 331.829 973.498 327.998 Z';

/** The two eyes, master and small cut: [cx, cy, rx, ry]. */
export const EYES = [
  [656.739, 529.788, 19.877, 32.88],
  [738.818, 508.475, 19.877, 32.88],
] as const;
export const EYES_SMALL = [
  [627.536, 546.036, 36, 52],
  [741.393, 503.339, 36, 52],
] as const;
/** Degrees both eyes lean. */
export const EYE_TILT = -16.037;

/** Where the fold's rim leaves the raised tip, and where its free edge meets the belly. */
export const TIP = { x: 1015.663, y: 313.301 } as const;
export const JOIN = { x: 791.635, y: 696.998 } as const;

/** The artwork sits in a 1024 square through this: `translate(TX TY) scale(SCALE)`. */
export const ART_SCALE = 1.12421581;
export const ART_TX = -225.485571;
export const ART_TY = -133.861982;
export const ART_TRANSFORM = `translate(${ART_TX} ${ART_TY}) scale(${ART_SCALE})`;

/** The character's own colours. They are not theme colours: never route them through --brand or --on-brand. */
export const TOP_COLOR = '#494bdc';
export const UNDERSIDE_COLOR = '#fe8b6d';
export const EYE_COLOR = '#fefefd';

/** Largest rendered size, px, that uses the small cut. */
export const SMALL_MAX = 32;

/** The living mascot's canvas is this many times its box, centred on it, so cloth that swings out of the box is not
 *  cut off. The still artwork never leaves the box. */
export const OVERSCAN = 2;
