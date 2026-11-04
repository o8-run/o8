'use client';

import { MODEL_IDS } from '@/lib/models';

import type { CSSProperties } from 'react';
import { relativeTimeLabel } from '@/lib/format/relative-time';

/* ── Inline Phosphor SVG path data (regular weight, 256x256 viewBox) ─────── */
/* Extracted from @phosphor-icons/react/dist/defs/*.es.js to avoid Turbopack  */
/* resolution failures on those .es.js barrel files.                           */

export const ICON_PATHS = {
  ArrowLeft: 'M224,128a8,8,0,0,1-8,8H59.31l58.35,58.34a8,8,0,0,1-11.32,11.32l-72-72a8,8,0,0,1,0-11.32l72-72a8,8,0,0,1,11.32,11.32L59.31,120H216A8,8,0,0,1,224,128Z',
  ArrowClockwise: 'M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16H211.4L184.81,71.64l-.25-.24a80,80,0,1,0-1.67,114.78,8,8,0,0,1,11,11.63A95.44,95.44,0,0,1,128,224h-1.32A96,96,0,1,1,195.75,60L224,85.8V56a8,8,0,1,1,16,0Z',
  ArrowClockwiseThin: 'M236,56v48a4,4,0,0,1-4,4H184a4,4,0,0,1,0-8h37.7L187.53,68.69l-.13-.12a84,84,0,1,0-1.75,120.51,4,4,0,0,1,5.5,5.82A91.43,91.43,0,0,1,128,220h-1.26A92,92,0,1,1,193,62.84l35,32.05V56a4,4,0,1,1,8,0Z',
  CaretDown: 'M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z',
  CaretRight: 'M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z',
  ChatCircleDots: 'M140,128a12,12,0,1,1-12-12A12,12,0,0,1,140,128ZM84,116a12,12,0,1,0,12,12A12,12,0,0,0,84,116Zm88,0a12,12,0,1,0,12,12A12,12,0,0,0,172,116Zm60,12A104,104,0,0,1,79.12,219.82L45.07,231.17a16,16,0,0,1-20.24-20.24l11.35-34.05A104,104,0,1,1,232,128Zm-16,0A88,88,0,1,0,51.81,172.06a8,8,0,0,1,.66,6.54L40,216,77.4,203.53a7.85,7.85,0,0,1,2.53-.42,8,8,0,0,1,4,1.08A88,88,0,0,0,216,128Z',
  CheckCircle: 'M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z',
  Gear: 'M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.21,107.21,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186,40.54a8,8,0,0,0-3.94-6,107.71,107.71,0,0,0-26.25-10.87,8,8,0,0,0-7.06,1.49L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3,3L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.21,107.21,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3,3L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3-3L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06Zm-16.1-6.5a73.93,73.93,0,0,1,0,8.68,8,8,0,0,0,1.74,5.48l14.19,17.73a91.57,91.57,0,0,1-6.23,15L187,173.11a8,8,0,0,0-5.1,2.64,74.11,74.11,0,0,1-6.14,6.14,8,8,0,0,0-2.64,5.1l-2.51,22.58a91.32,91.32,0,0,1-15,6.23l-17.74-14.19a8,8,0,0,0-5-1.75h-.48a73.93,73.93,0,0,1-8.68,0,8,8,0,0,0-5.48,1.74L100.45,215.8a91.57,91.57,0,0,1-15-6.23L82.89,187a8,8,0,0,0-2.64-5.1,74.11,74.11,0,0,1-6.14-6.14,8,8,0,0,0-5.1-2.64L46.43,170.6a91.32,91.32,0,0,1-6.23-15l14.19-17.74a8,8,0,0,0,1.74-5.48,73.93,73.93,0,0,1,0-8.68,8,8,0,0,0-1.74-5.48L40.2,100.45a91.57,91.57,0,0,1,6.23-15L69,82.89a8,8,0,0,0,5.1-2.64,74.11,74.11,0,0,1,6.14-6.14A8,8,0,0,0,82.89,69L85.4,46.43a91.32,91.32,0,0,1,15-6.23l17.74,14.19a8,8,0,0,0,5.48,1.74,73.93,73.93,0,0,1,8.68,0,8,8,0,0,0,5.48-1.74L155.55,40.2a91.57,91.57,0,0,1,15,6.23L173.11,69a8,8,0,0,0,2.64,5.1,74.11,74.11,0,0,1,6.14,6.14,8,8,0,0,0,5.1,2.64l22.58,2.51a91.32,91.32,0,0,1,6.23,15l-14.19,17.74A8,8,0,0,0,199.87,123.66Z',
  List: 'M224,128a8,8,0,0,1-8,8H40a8,8,0,0,1,0-16H216A8,8,0,0,1,224,128ZM40,72H216a8,8,0,0,0,0-16H40a8,8,0,0,0,0,16ZM216,184H40a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Z',
  MoonStars: 'M240,96a8,8,0,0,1-8,8H216v16a8,8,0,0,1-16,0V104H184a8,8,0,0,1,0-16h16V72a8,8,0,0,1,16,0V88h16A8,8,0,0,1,240,96ZM144,56h8v8a8,8,0,0,0,16,0V56h8a8,8,0,0,0,0-16h-8V32a8,8,0,0,0-16,0v8h-8a8,8,0,0,0,0,16Zm72.77,97a8,8,0,0,1,1.43,8A96,96,0,1,1,95.07,37.8a8,8,0,0,1,10.6,9.06A88.07,88.07,0,0,0,209.14,150.33,8,8,0,0,1,216.77,153Zm-19.39,14.88c-1.79.09-3.59.14-5.38.14A104.11,104.11,0,0,1,88,64c0-1.79,0-3.59.14-5.38A80,80,0,1,0,197.38,167.86Z',
  PaperPlaneTilt: 'M227.32,28.68a16,16,0,0,0-15.66-4.08l-.15,0L19.57,82.84a16,16,0,0,0-2.49,29.8L102,154l41.3,84.87A15.86,15.86,0,0,0,157.74,248q.69,0,1.38-.06a15.88,15.88,0,0,0,14-11.51l58.2-191.94c0-.05,0-.1,0-.15A16,16,0,0,0,227.32,28.68ZM157.83,231.85l-.05.14,0-.07-40.06-82.3,48-48a8,8,0,0,0-11.31-11.31l-48,48L24.08,98.25l-.07,0,.14,0L216,40Z',
  PencilSimple: 'M227.31,73.37,182.63,28.68a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96a16,16,0,0,0,0-22.63ZM92.69,208H48V163.31l88-88L180.69,120ZM192,108.68,147.31,64l24-24L216,84.68Z',
  Shield: 'M208,40H48A16,16,0,0,0,32,56v56c0,52.72,25.52,84.67,46.93,102.19,23.06,18.86,46,25.27,47,25.53a8,8,0,0,0,4.2,0c1-.26,23.91-6.67,47-25.53C198.48,196.67,224,164.72,224,112V56A16,16,0,0,0,208,40Zm0,72c0,37.07-13.66,67.16-40.6,89.42A129.3,129.3,0,0,1,128,223.62a128.25,128.25,0,0,1-38.92-21.81C61.82,179.51,48,149.3,48,112l0-56,160,0Z',
  SpeakerHigh: 'M155.51,24.81a8,8,0,0,0-8.42.88L77.25,80H32A16,16,0,0,0,16,96v64a16,16,0,0,0,16,16H77.25l69.84,54.31A8,8,0,0,0,160,224V32A8,8,0,0,0,155.51,24.81ZM32,96H72v64H32ZM144,207.64,88,164.09V91.91l56-43.55Zm54-106.08a40,40,0,0,1,0,52.88,8,8,0,0,1-12-10.58,24,24,0,0,0,0-31.72,8,8,0,0,1,12-10.58ZM248,128a79.9,79.9,0,0,1-20.37,53.34,8,8,0,0,1-11.92-10.67,64,64,0,0,0,0-85.33,8,8,0,1,1,11.92-10.67A79.83,79.83,0,0,1,248,128Z',
  Star: 'M239.18,97.26A16.38,16.38,0,0,0,224.92,86l-59-4.76L143.14,26.15a16.36,16.36,0,0,0-30.27,0L90.11,81.23,31.08,86a16.46,16.46,0,0,0-9.37,28.86l45,38.83L53,211.75a16.38,16.38,0,0,0,24.5,17.82L128,198.49l50.53,31.08A16.4,16.4,0,0,0,203,211.75l-13.76-58.07,45-38.83A16.43,16.43,0,0,0,239.18,97.26Zm-15.34,5.47-48.7,42a8,8,0,0,0-2.56,7.91l14.88,62.8a.37.37,0,0,1-.17.48c-.18.14-.23.11-.38,0l-54.72-33.65a8,8,0,0,0-8.38,0L69.09,215.94c-.15.09-.19.12-.38,0a.37.37,0,0,1-.17-.48l14.88-62.8a8,8,0,0,0-2.56-7.91l-48.7-42c-.12-.1-.23-.19-.13-.5s.18-.27.33-.29l63.92-5.16A8,8,0,0,0,103,91.86l24.62-59.61c.08-.17.11-.25.35-.25s.27.08.35.25L153,91.86a8,8,0,0,0,6.75,4.92l63.92,5.16c.15,0,.24,0,.33.29S224,102.63,223.84,102.73Z',
  StopCircle: 'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216ZM160,88H96a8,8,0,0,0-8,8v64a8,8,0,0,0,8,8h64a8,8,0,0,0,8-8V96A8,8,0,0,0,160,88Zm-8,64H104V104h48Z',
  SunDim: 'M120,40V32a8,8,0,0,1,16,0v8a8,8,0,0,1-16,0Zm72,88a64,64,0,1,1-64-64A64.07,64.07,0,0,1,192,128Zm-16,0a48,48,0,1,0-48,48A48.05,48.05,0,0,0,176,128ZM58.34,69.66A8,8,0,0,0,69.66,58.34l-8-8A8,8,0,0,0,50.34,61.66Zm0,116.68-8,8a8,8,0,0,0,11.32,11.32l8-8a8,8,0,0,0-11.32-11.32ZM192,72a8,8,0,0,0,5.66-2.34l8-8a8,8,0,0,0-11.32-11.32l-8,8A8,8,0,0,0,192,72Zm5.66,114.34a8,8,0,0,0-11.32,11.32l8,8a8,8,0,0,0,11.32-11.32ZM40,120H32a8,8,0,0,0,0,16h8a8,8,0,0,0,0-16Zm88,88a8,8,0,0,0-8,8v8a8,8,0,0,0,16,0v-8A8,8,0,0,0,128,208Zm96-88h-8a8,8,0,0,0,0,16h8a8,8,0,0,0,0-16Z',
  Trash: 'M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z',
  Copy: 'M196,64V192a12,12,0,0,1-12,12H88a12,12,0,0,1-12-12V64A12,12,0,0,1,88,52h96A12,12,0,0,1,196,64Zm-12,0H88V192h96ZM52,176a6,6,0,0,1-12,0V88A20,20,0,0,1,60,68h88a6,6,0,0,1,0,12H60a8,8,0,0,0-8,8Z',
  FileText: 'M213.66,82.34l-56-56A8,8,0,0,0,152,24H56A16,16,0,0,0,40,40V216a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V88A8,8,0,0,0,213.66,82.34ZM160,51.31,188.69,80H160ZM200,216H56V40h88V88a8,8,0,0,0,8,8h48V216Zm-32-80a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,136Zm0,32a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,168Z',
  TerminalWindow: 'M128,128a8,8,0,0,1-8,8H72a8,8,0,0,1,0-16h48A8,8,0,0,1,128,128Zm-8,24H72a8,8,0,0,0,0,16h48a8,8,0,0,0,0-16ZM232,56V200a16,16,0,0,1-16,16H40a16,16,0,0,1-16-16V56A16,16,0,0,1,40,40H216A16,16,0,0,1,232,56ZM216,56H40V200H216ZM189.66,98.34a8,8,0,0,1,0,11.32L163.31,136l26.35,26.34a8,8,0,0,1-11.32,11.32l-32-32a8,8,0,0,1,0-11.32l32-32A8,8,0,0,1,189.66,98.34Z',
  MagnifyingGlass: 'M229.66,218.34l-50.07-50.07a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.31ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z',
  Brain: 'M248,132a56.07,56.07,0,0,0-32-50.61V80a48,48,0,0,0-88-26.49A48,48,0,0,0,40,80v1.39a56,56,0,0,0,0,101.2V184a48,48,0,0,0,88,26.49A48,48,0,0,0,216,184v-1.41A56.09,56.09,0,0,0,248,132ZM88,216a32,32,0,0,1-31.81-28.56A55.87,55.87,0,0,0,64,188h8a8,8,0,0,0,0-16H64A40,40,0,0,1,50.67,94.28,8,8,0,0,0,56,86.71V80a32,32,0,0,1,64,0v68.26A47.8,47.8,0,0,0,88,136a8,8,0,0,0,0,16,32,32,0,0,1,0,64Zm104-44h-8a8,8,0,0,0,0,16h8a55.87,55.87,0,0,0,7.81-.56A32,32,0,1,1,168,152a8,8,0,0,0,0-16,47.8,47.8,0,0,0-32,12.26V80a32,32,0,0,1,64,0v6.71a8,8,0,0,0,5.33,7.57A40,40,0,0,1,192,172Zm16-52a8,8,0,0,1-8,8h-4a36,36,0,0,1-36-36V88a8,8,0,0,1,16,0v4a20,20,0,0,0,20,20h4A8,8,0,0,1,208,120ZM60,120a8,8,0,0,1,8-8h4a20,20,0,0,0,20-20V88a8,8,0,0,1,16,0v4a36,36,0,0,1-36,36H68A8,8,0,0,1,60,120Z',
  UsersThree: 'M244.8,150.4a8,8,0,0,1-11.2-1.6A51.6,51.6,0,0,0,192,128a8,8,0,0,1-7.37-4.89,8,8,0,0,1,0-6.22A8,8,0,0,1,192,112a24,24,0,1,0-23.24-30,8,8,0,1,1-15.5-4A40,40,0,1,1,219,117.51a67.94,67.94,0,0,1,27.43,21.68A8,8,0,0,1,244.8,150.4ZM190.92,212a8,8,0,1,1-13.84,8,57,57,0,0,0-98.16,0,8,8,0,1,1-13.84-8,72.06,72.06,0,0,1,33.74-29.92,48,48,0,1,1,58.36,0A72.06,72.06,0,0,1,190.92,212ZM128,176a32,32,0,1,0-32-32A32,32,0,0,0,128,176ZM72,120a8,8,0,0,0-8-8A24,24,0,1,1,87.24,82a8,8,0,1,0,15.5-4A40,40,0,1,0,37,117.51,67.94,67.94,0,0,0,9.6,139.19a8,8,0,1,0,12.8,9.61A51.6,51.6,0,0,1,64,128,8,8,0,0,0,72,120Z',
  Bug: 'M168,160a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,160Zm-8-40H96a8,8,0,0,0,0,16h64a8,8,0,0,0,0-16Zm56-32H190.65A40,40,0,0,0,164,57.06l13.66-13.65a8,8,0,1,0-11.32-11.32L148.94,49.46a40.31,40.31,0,0,0-41.88,0L89.66,32.09A8,8,0,0,0,78.34,43.41L92,57.06A40,40,0,0,0,65.35,88H40a8,8,0,0,0,0,16H64v8a87.66,87.66,0,0,0,3.07,23.13L25.55,151.34A8,8,0,1,0,32,166l38.34-17.42A88,88,0,0,0,80.2,166.81L41.39,205.62a8,8,0,1,0,11.32,11.31L91.68,178a87.5,87.5,0,0,0,72.64,0l39,39a8,8,0,1,0,11.31-11.31l-38.81-38.82a88,88,0,0,0,9.86-18.27L224,166a8,8,0,0,0,6.4-14.66l-41.46-18.83A87.66,87.66,0,0,0,192,112v-8h24a8,8,0,0,0,0-16ZM104,48a24,24,0,0,1,48,0Zm72,64v8a72,72,0,0,1-144,0v-8Z',
  Pulse: 'M240,128a8,8,0,0,1-8,8H204.94l-37.78,75.58A8,8,0,0,1,160,216h-.4a8,8,0,0,1-7.08-5.14L95.35,60.76l-29,77.4A8,8,0,0,1,58.84,144H24a8,8,0,0,1,0-16H53.3l34.85-92.92a8,8,0,0,1,15-.14l57.51,151,31.2-62.41A8,8,0,0,1,199,120h33A8,8,0,0,1,240,128Z',
  ChartLine: 'M232,208a8,8,0,0,1-8,8H32a8,8,0,0,1-8-8V48a8,8,0,0,1,16,0v94.37l52.73-52.74a8,8,0,0,1,11.32,0L128,124.69,180.69,72H160a8,8,0,0,1,0-16h40a8,8,0,0,1,8,8V104a8,8,0,0,1-16,0V83.31L133.66,138a8,8,0,0,1-11.32,0L98.34,114.34l-58.34,58.35V200H224A8,8,0,0,1,232,208Z',
  Compass: 'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm60.85-130.08a8,8,0,0,0-9.69-1.57L116.91,113.79a8.05,8.05,0,0,0-3.85,3.85L84.19,179.7a8,8,0,0,0,9.69,11.49l62.25-29a8.05,8.05,0,0,0,3.85-3.85l29-62.25A8,8,0,0,0,188.85,85.92ZM149.3,149.32l-31.5,14.69,14.69-31.5,31.5-14.69Z',
  Plus: 'M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z',
  CaretUp: 'M213.66,165.66a8,8,0,0,1-11.32,0L128,91.31,53.66,165.66a8,8,0,0,1-11.32-11.32l80-80a8,8,0,0,1,11.32,0l80,80A8,8,0,0,1,213.66,165.66Z',
  X: 'M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z',
  Clock: 'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z',
  Globe: 'M128,24h0A104,104,0,1,0,232,128,104.12,104.12,0,0,0,128,24Zm88,104a87.61,87.61,0,0,1-3.33,24H174.16a157.44,157.44,0,0,0,0-48h38.51A87.61,87.61,0,0,1,216,128ZM102,168H154a115.11,115.11,0,0,1-26,45A115.27,115.27,0,0,1,102,168Zm-3.9-16a140.84,140.84,0,0,1,0-48h59.88a140.84,140.84,0,0,1,0,48ZM40,128a87.61,87.61,0,0,1,3.33-24H81.84a157.44,157.44,0,0,0,0,48H43.33A87.61,87.61,0,0,1,40,128ZM154,88H102a115.11,115.11,0,0,1,26-45A115.27,115.27,0,0,1,154,88Zm52.33,0H170.71a135.28,135.28,0,0,0-22.3-45.6A88.29,88.29,0,0,1,206.37,88ZM107.59,42.4A135.28,135.28,0,0,0,85.29,88H49.63A88.29,88.29,0,0,1,107.59,42.4ZM49.63,168H85.29a135.28,135.28,0,0,0,22.3,45.6A88.29,88.29,0,0,1,49.63,168Zm98.78,45.6a135.28,135.28,0,0,0,22.3-45.6h35.66A88.29,88.29,0,0,1,148.41,213.6Z',
} as const;

export type MobileView =
  | 'approvals'
  | 'browser'
  | 'chat'
  | 'settings'
  | 'agents'
  | 'issues'
  | 'prs'
  | 'activity'
  | 'costs'
  | 'orchestrator';

export interface ApprovalGateViolation {
  category: 'security' | 'budget' | 'integrity';
  severity: 'block' | 'warn';
  label: string;
  detail: string;
  file?: string;
}

export interface ApprovalItem {
  id: string;
  title: string;
  description?: string;
  summary?: string;
  risk: 'low' | 'medium' | 'high';
  source?: 'llm-chat' | 'runtime' | 'test';
  toolName?: string;
  sessionKey?: string;
  status: string;
  createdAt: number;
  metadata?: Record<string, string>;
  continuation?: { kind: 'llm-chat' | 'runtime' | 'lane' };
  gateResult?: { passed: boolean; violations: ApprovalGateViolation[] };
  conflictReport?: { files: string[]; mergeError?: string };
}

export type MobileChatToolStatus = 'calling' | 'running' | 'done' | 'blocked' | 'error';

export interface MobileChatToolResult {
  output?: string;
  diff?: unknown;
  status?: MobileChatToolStatus;
}

export interface MobileChatToolCall {
  toolCallId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  filePath?: string;
  status?: MobileChatToolStatus;
  result?: MobileChatToolResult;
  isError?: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  toolCalls?: MobileChatToolCall[];
}

export interface ChatHistoryRecord {
  tabId: string;
  title: string;
  lastMessage: string;
  updatedAt: string;
  model?: string;
  starred?: boolean;
}

export type CliEffort = 'low' | 'medium' | 'high' | 'max';

export interface ModelOption {
  id: string;
  label: string;
  provider: 'google' | 'anthropic' | 'openai';
  description: string;
  backend?: 'cli' | 'api';
  cliRuntime?: 'claude-code' | 'codex' | 'gemini';
  defaultEffort?: CliEffort;
}

export interface MobilePalette {
  isDark: boolean;
  rootBackground: string;
  rootText: string;
  mutedText: string;
  subduedText: string;
  sidebarBackground: string;
  overlayBackground: string;
  panelBackground: string;
  panelElevated: string;
  cardBackground: string;
  cardBorder: string;
  menuBackground: string;
  accent: string;
  accentSoft: string;
  accentBorder: string;
  success: string;
  successSoft: string;
  successBorder: string;
  danger: string;
  dangerSoft: string;
  dangerBorder: string;
  warning: string;
  warningSoft: string;
  inputBackground: string;
  inputBorder: string;
  composerBackground: string;
  userBubble: string;
  iconFill: IconFill;
  inverseIconFill: IconFill;
  shadow: string;
}

export type IconFill = string;

export const MOBILE_CARD_RADIUS = 14;
export const MOBILE_TOUCH_TARGET = 44;
export const MOBILE_BODY_TRACKING = '-0.01em';
export const MOBILE_HEADING_TRACKING = '-0.02em';
export const MOBILE_GLASS_BLUR = 20;

export const RISK_COLORS: Record<string, string> = {
  high: '#ef4444',
  medium: '#f59e0b',
  low: '#22c55e',
};

/** CLI-backed models — use installed runtimes, no API key needed.
 *  claude-code rows removed June 2026 (Anthropic Agent SDK credit pool change). */
export const CLI_MODELS: ModelOption[] = [
  { id: MODEL_IDS.mobileCliDefault, label: 'GPT-6.1 Sol', provider: 'openai', description: 'Codex', backend: 'cli', cliRuntime: 'codex' },
  { id: 'cli:codex:gpt-5.6-sol', label: 'GPT-5.6 Sol', provider: 'openai', description: 'Codex', backend: 'cli', cliRuntime: 'codex' },
  { id: 'cli:codex:gpt-5.6-terra', label: 'GPT-5.6 Terra', provider: 'openai', description: 'Codex', backend: 'cli', cliRuntime: 'codex' },
  { id: 'cli:codex:gpt-5.6-luna', label: 'GPT-5.6 Luna', provider: 'openai', description: 'Codex', backend: 'cli', cliRuntime: 'codex' },
  { id: 'cli:codex:gpt-5.5', label: 'GPT-5.5', provider: 'openai', description: 'Codex', backend: 'cli', cliRuntime: 'codex' },
  { id: 'cli:codex:o4-mini', label: 'o4-mini', provider: 'openai', description: 'Codex', backend: 'cli', cliRuntime: 'codex' },
  { id: 'cli:gemini:gemini-3.1-pro', label: 'Gemini 3.1 Pro', provider: 'google', description: 'Gemini CLI', backend: 'cli', cliRuntime: 'gemini' },
  { id: 'cli:gemini:gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'google', description: 'Gemini CLI', backend: 'cli', cliRuntime: 'gemini' },
];

/** API-backed models — require BYOK key */
export const API_MODELS: ModelOption[] = [
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', provider: 'google', description: 'Via API key', backend: 'api' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'anthropic', description: 'Via API key', backend: 'api' },
  { id: MODEL_IDS.mobileOpenAiDefault, label: 'GPT-6.1 Sol', provider: 'openai', description: 'Via API key', backend: 'api' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', provider: 'openai', description: 'Via API key', backend: 'api' },
  { id: 'gpt-5.5', label: 'GPT-5.5', provider: 'openai', description: 'Via API key', backend: 'api' },
];

export const AVAILABLE_MODELS: ModelOption[] = [...CLI_MODELS, ...API_MODELS];

export const DEFAULT_MOBILE_CHAT_MODEL = MODEL_IDS.mobileCliDefault;
export const MOBILE_CHAT_STORAGE_KEY = 'o8-mobile-chat-tab';
export const MOBILE_CHAT_MODEL_STORAGE_KEY = 'o8-mobile-chat-model';
export const MOBILE_EFFORT_STORAGE_KEY = 'o8-mobile-effort';

export const EFFORT_LEVELS: { value: CliEffort; label: string; description: string }[] = [
  { value: 'low', label: 'Low', description: 'Quick, minimal thinking' },
  { value: 'medium', label: 'Medium', description: 'Balanced speed and depth' },
  { value: 'high', label: 'High', description: 'Deep thinking, thorough' },
  { value: 'max', label: 'Max', description: 'Maximum reasoning depth' },
];

export function getStoredEffort(): CliEffort | null {
  try {
    const stored = window.localStorage.getItem(MOBILE_EFFORT_STORAGE_KEY);
    if (stored && ['low', 'medium', 'high', 'max'].includes(stored)) return stored as CliEffort;
    return null;
  } catch {
    return null;
  }
}

export function storeEffort(effort: CliEffort | null) {
  try {
    if (effort) {
      window.localStorage.setItem(MOBILE_EFFORT_STORAGE_KEY, effort);
    } else {
      window.localStorage.removeItem(MOBILE_EFFORT_STORAGE_KEY);
    }
  } catch { /* ignore */ }
}
export const POLL_INTERVAL = 5_000;
export const SIDEBAR_WIDTH = 280;
export const MAX_RECENT_CONVERSATIONS = 10;
export const CHAT_TITLE_MAX_LENGTH = 50;
export const SIDEBAR_TITLE_MAX_LENGTH = 40;

/**
 * Build a vertical scroll-fade mask for a scroll container so content fades
 * out behind sticky headers / composers / FABs instead of cleanly cutting off.
 *
 * Pass the actual visible offsets in px:
 *  - `top`: distance from the top of the scroll container that should fade in
 *           (matches the height of any sticky header that overlays content).
 *           Pass 0 to skip the top fade.
 *  - `bottom`: distance from the bottom that should fade out (matches the
 *              height of a composer / FAB that overlays content). Pass 0 to
 *              skip the bottom fade.
 *  - `edge`: pixels of solid clear area at the very edge before the gradient
 *            starts (default 0 — fade begins immediately at the edge).
 *
 * Returns both `maskImage` and `WebkitMaskImage` because Safari still needs
 * the prefix. Callers spread the result into an existing style object.
 */
export function mobileScrollFadeStyle({
  top = 0,
  bottom = 0,
  edge = 0,
}: {
  top?: number;
  bottom?: number;
  edge?: number;
} = {}): CSSProperties {
  const stops: string[] = [];
  if (top > 0) {
    if (edge > 0) stops.push(`transparent 0px`);
    stops.push(`transparent ${edge}px`);
    stops.push(`black ${edge + top}px`);
  } else {
    stops.push(`black 0px`);
  }
  if (bottom > 0) {
    stops.push(`black calc(100% - ${edge + bottom}px)`);
    if (edge > 0) stops.push(`transparent calc(100% - ${edge}px)`);
    stops.push(`transparent 100%`);
  } else {
    stops.push(`black 100%`);
  }
  const gradient = `linear-gradient(to bottom, ${stops.join(', ')})`;
  return {
    maskImage: gradient,
    WebkitMaskImage: gradient,
  } as CSSProperties;
}

function renderIcon(pathData: string, size: number, fill: IconFill, style?: CSSProperties) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" style={style} aria-hidden="true">
      <path d={pathData} fill={fill} />
    </svg>
  );
}

interface MobileIconProps {
  fill: IconFill;
  size?: number;
  style?: CSSProperties;
}

export function IconArrowLeft({ fill, size = 18, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.ArrowLeft, size, fill, style);
}

export function IconCaretDown({ fill, size = 18, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.CaretDown, size, fill, style);
}

export function IconCaretRight({ fill, size = 16, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.CaretRight, size, fill, style);
}

export function IconCaretUp({ fill, size = 16, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.CaretUp, size, fill, style);
}

export function IconPlus({ fill, size = 16, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.Plus, size, fill, style);
}

export function IconChat({ fill, size = 20, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.ChatCircleDots, size, fill, style);
}

export function IconCheck({ fill, size = 48, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.CheckCircle, size, fill, style);
}

export function IconGear({ fill, size = 20, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.Gear, size, fill, style);
}

export function IconHamburger({ fill, size = 22, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.List, size, fill, style);
}

export function IconMoon({ fill, size = 18, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.MoonStars, size, fill, style);
}

export function IconRefresh({ fill, size = 18, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.ArrowClockwiseThin, size, fill, style);
}

export function IconSearch({ fill, size = 20, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.MagnifyingGlass, size, fill, style);
}

export function IconClose({ fill, size = 20, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.X, size, fill, style);
}

export function IconSend({ fill, size = 16, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.PaperPlaneTilt, size, fill, style);
}

export function IconShield({ fill, size = 20, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.Shield, size, fill, style);
}

export function IconBrain({ fill, size = 20, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.Brain, size, fill, style);
}

export function IconAgents({ fill, size = 20, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.UsersThree, size, fill, style);
}

export function IconIssues({ fill, size = 20, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.Bug, size, fill, style);
}

export function IconActivity({ fill, size = 20, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.Pulse, size, fill, style);
}

export function IconCosts({ fill, size = 20, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.ChartLine, size, fill, style);
}

export function IconOrchestrator({ fill, size = 20, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.Compass, size, fill, style);
}

export function IconSpeaker({ fill, size = 12, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.SpeakerHigh, size, fill, style);
}

export function IconStar({ fill, size = 18, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.Star, size, fill, style);
}

export function IconStop({ fill, size = 12, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.StopCircle, size, fill, style);
}

export function IconSun({ fill, size = 18, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.SunDim, size, fill, style);
}

export function IconTrash({ fill, size = 18, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.Trash, size, fill, style);
}

export function IconPencil({ fill, size = 18, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.PencilSimple, size, fill, style);
}

export function IconCopy({ fill, size = 18, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.Copy, size, fill, style);
}

export function IconClock({ fill, size = 12, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.Clock, size, fill, style);
}

export function IconBrowser({ fill, size = 20, style }: MobileIconProps) {
  return renderIcon(ICON_PATHS.Globe, size, fill, style);
}

export function getModelOption(modelId: string): ModelOption | null {
  return AVAILABLE_MODELS.find((model) => model.id === modelId) ?? null;
}

export function readStoredMobileModel() {
  if (typeof window === 'undefined') return DEFAULT_MOBILE_CHAT_MODEL;
  try {
    const stored = window.localStorage.getItem(MOBILE_CHAT_MODEL_STORAGE_KEY);
    return stored && getModelOption(stored) ? stored : DEFAULT_MOBILE_CHAT_MODEL;
  } catch {
    return DEFAULT_MOBILE_CHAT_MODEL;
  }
}

const DARK_PALETTE: MobilePalette = {
  isDark: true,
  rootBackground: '#111111',
  rootText: '#FAF5F0',
  mutedText: 'rgba(250, 245, 240, 0.84)',
  subduedText: 'rgba(160, 152, 144, 0.92)',
  sidebarBackground: 'rgba(17, 17, 17, 0.78)',
  overlayBackground: 'rgba(5, 8, 13, 0.62)',
  panelBackground: 'rgba(30, 28, 26, 0.82)',
  panelElevated: 'rgba(46, 42, 38, 0.9)',
  cardBackground: 'rgba(32, 28, 24, 0.75)',
  cardBorder: 'rgba(255, 248, 240, 0.07)',
  menuBackground: 'rgba(30, 28, 26, 0.92)',
  accent: '#2563eb',
  accentSoft: 'rgba(37, 99, 235, 0.16)',
  accentBorder: 'rgba(96, 165, 250, 0.28)',
  success: '#22c55e',
  successSoft: 'rgba(34, 197, 94, 0.14)',
  successBorder: 'rgba(74, 222, 128, 0.24)',
  danger: '#ef4444',
  dangerSoft: 'rgba(239, 68, 68, 0.14)',
  dangerBorder: 'rgba(248, 113, 113, 0.24)',
  warning: '#f59e0b',
  warningSoft: 'rgba(245, 158, 11, 0.14)',
  inputBackground: 'rgba(30, 28, 26, 0.82)',
  inputBorder: 'rgba(255, 248, 240, 0.1)',
  composerBackground: 'rgba(30, 28, 26, 0.82)',
  userBubble: 'rgba(10, 132, 255, 0.15)',
  iconFill: '#FAF5F0',
  inverseIconFill: '#111111',
  shadow: '0 24px 60px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
};

const LIGHT_PALETTE: MobilePalette = {
  isDark: false,
  rootBackground: '#f5f3ef',
  rootText: '#1a1a2e',
  mutedText: 'rgba(26, 26, 46, 0.62)',
  subduedText: 'rgba(26, 26, 46, 0.48)',
  sidebarBackground: 'rgba(245, 243, 239, 0.92)',
  overlayBackground: 'rgba(0, 0, 0, 0.24)',
  panelBackground: 'rgba(255, 255, 255, 0.72)',
  panelElevated: 'rgba(255, 255, 255, 0.82)',
  cardBackground: 'rgba(255, 255, 255, 0.6)',
  cardBorder: 'rgba(0, 0, 0, 0.08)',
  menuBackground: 'rgba(255, 255, 255, 0.94)',
  accent: '#2563eb',
  accentSoft: 'rgba(37, 99, 235, 0.1)',
  accentBorder: 'rgba(37, 99, 235, 0.2)',
  success: '#16a34a',
  successSoft: 'rgba(22, 163, 74, 0.1)',
  successBorder: 'rgba(22, 163, 74, 0.2)',
  danger: '#dc2626',
  dangerSoft: 'rgba(220, 38, 38, 0.08)',
  dangerBorder: 'rgba(220, 38, 38, 0.18)',
  warning: '#d97706',
  warningSoft: 'rgba(217, 119, 6, 0.1)',
  inputBackground: 'rgba(255, 255, 255, 0.78)',
  inputBorder: 'rgba(0, 0, 0, 0.12)',
  composerBackground: 'transparent',
  userBubble: 'rgba(37, 99, 235, 0.1)',
  iconFill: '#1a1a2e',
  inverseIconFill: '#f8fafc',
  shadow: '0 8px 32px rgba(0, 0, 0, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.6)',
};

export function getMobilePalette(themeId: string): MobilePalette {
  return themeId === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
}

export function glassButtonStyle(
  size: number,
  tint: 'neutral' | 'teal' | 'rose' | 'orange' | 'accent',
  active: boolean,
  palette: MobilePalette,
): CSSProperties {
  const activeBackgrounds: Record<string, string> = {
    neutral: 'rgba(255, 255, 255, 0.08)',
    teal: 'rgba(34, 197, 94, 0.18)',
    rose: 'rgba(239, 68, 68, 0.18)',
    orange: 'rgba(245, 158, 11, 0.18)',
    accent: 'rgba(37, 99, 235, 0.2)',
  };

  return {
    width: size,
    height: size,
    minWidth: MOBILE_TOUCH_TARGET,
    minHeight: MOBILE_TOUCH_TARGET,
    borderRadius: MOBILE_CARD_RADIUS,
    border: `1px solid ${active ? palette.accentBorder : palette.cardBorder}`,
    background: active ? activeBackgrounds[tint] : palette.panelBackground,
    boxShadow: active ? palette.shadow : 'none',
    cursor: active ? 'pointer' : 'default',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    opacity: active ? 1 : 0.45,
    transition: 'all 0.22s ease',
    backdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
    WebkitBackdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
  };
}

export function isGovernanceApproval(approval: ApprovalItem): boolean {
  if (approval.continuation?.kind === 'lane') return true;
  if (approval.risk === 'high') return true;
  if (approval.source === 'test') return false;
  if (approval.continuation?.kind === 'llm-chat') return false;
  if (approval.continuation?.kind === 'runtime') return false;
  if (approval.source === 'llm-chat') return false;
  if (approval.source === 'runtime') return false;
  return false;
}

export function timeAgo(timestamp: number): string {
  return relativeTimeLabel(timestamp, { subMinute: 'just-now-lower' });
}

export function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

export function generateChatTabId(): string {
  if (typeof window !== 'undefined' && typeof window.crypto?.randomUUID === 'function') {
    return `mobile-chat-${window.crypto.randomUUID()}`;
  }
  return `mobile-chat-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function extractMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('\n')
      .trim();
  }
  if (content && typeof content === 'object' && 'text' in content && typeof content.text === 'string') {
    return content.text;
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readToolStatus(value: unknown): MobileChatToolStatus | undefined {
  return value === 'calling'
    || value === 'running'
    || value === 'done'
    || value === 'blocked'
    || value === 'error'
    ? value
    : undefined;
}

function normalizeToolArguments(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return value;
}

function normalizeToolResult(value: unknown): MobileChatToolResult | undefined {
  if (typeof value === 'string') {
    return value.trim() ? { output: value } : undefined;
  }

  if (!isRecord(value)) return undefined;

  const output = typeof value.output === 'string'
    ? value.output
    : (typeof value.preview === 'string' ? value.preview : undefined);
  const status = readToolStatus(value.status);
  const diff = Object.prototype.hasOwnProperty.call(value, 'diff') ? value.diff : undefined;

  if (!output?.trim() && diff === undefined && !status) return undefined;

  return {
    ...(output?.trim() ? { output } : {}),
    ...(diff !== undefined ? { diff } : {}),
    ...(status ? { status } : {}),
  };
}

function normalizeToolCalls(value: unknown): MobileChatToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const toolCalls = value.reduce<MobileChatToolCall[]>((acc, entry, index) => {
    if (!isRecord(entry)) return acc;

    const toolName = typeof entry.toolName === 'string'
      ? entry.toolName
      : (typeof entry.name === 'string' ? entry.name : '');
    if (!toolName.trim()) return acc;

    const toolCallId = typeof entry.toolCallId === 'string' && entry.toolCallId.trim()
      ? entry.toolCallId
      : `mobile-tool-call-${index}-${toolName}`;
    const argumentsValue = normalizeToolArguments(
      Object.prototype.hasOwnProperty.call(entry, 'arguments')
        ? entry.arguments
        : entry.args,
    );
    const status = readToolStatus(entry.status);
    const filePath = typeof entry.filePath === 'string' && entry.filePath.trim()
      ? entry.filePath
      : undefined;
    const result = normalizeToolResult(
      Object.prototype.hasOwnProperty.call(entry, 'result')
        ? entry.result
        : {
            output: typeof entry.output === 'string' ? entry.output : entry.preview,
            diff: entry.diff,
            status: entry.status,
          },
    );

    acc.push({
      toolCallId,
      toolName,
      ...(argumentsValue ? { arguments: argumentsValue } : {}),
      ...(filePath ? { filePath } : {}),
      ...(status ? { status } : {}),
      ...(result ? { result } : {}),
      ...(entry.isError === true ? { isError: true } : {}),
    });

    return acc;
  }, []);

  return toolCalls.length > 0 ? toolCalls : undefined;
}

export function normalizeChatMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return [];

  return messages.reduce<ChatMessage[]>((acc, message) => {
    if (!message || typeof message !== 'object') return acc;
    const role = 'role' in message ? message.role : undefined;
    if (role !== 'user' && role !== 'assistant') return acc;
    const content = extractMessageContent('content' in message ? message.content : '');
    const thinking = 'thinking' in message && typeof message.thinking === 'string'
      ? message.thinking
      : undefined;
    const toolCalls = 'toolCalls' in message
      ? normalizeToolCalls(message.toolCalls)
      : undefined;
    acc.push({
      role,
      content,
      ...(thinking?.trim() ? { thinking } : {}),
      ...(toolCalls ? { toolCalls } : {}),
    });
    return acc;
  }, []);
}

export function getConversationTitle(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  return truncateText(firstUserMessage?.content ?? 'Untitled conversation', CHAT_TITLE_MAX_LENGTH);
}

export function normalizeHistoryList(data: unknown): ChatHistoryRecord[] {
  if (!data || typeof data !== 'object') return [];

  const items = 'items' in data && Array.isArray(data.items)
    ? data.items
    : ('conversations' in data && Array.isArray(data.conversations) ? data.conversations : []);

  return items
    .reduce<ChatHistoryRecord[]>((acc, item) => {
      if (!item || typeof item !== 'object') return acc;
      const tabId = 'tabId' in item && typeof item.tabId === 'string' ? item.tabId : '';
      if (!tabId) return acc;
      const title = 'title' in item && typeof item.title === 'string' && item.title.trim()
        ? item.title
        : 'Untitled conversation';
      const lastMessage = 'lastMessage' in item && typeof item.lastMessage === 'string'
        ? item.lastMessage
        : ('preview' in item && typeof item.preview === 'string' ? item.preview : '');
      const updatedAt = 'updatedAt' in item && typeof item.updatedAt === 'string'
        ? item.updatedAt
        : ('modifiedAt' in item && typeof item.modifiedAt === 'string' ? item.modifiedAt : '');
      const model = 'model' in item && typeof item.model === 'string' ? item.model : undefined;
      const starred = 'starred' in item && item.starred === true;

      acc.push({ tabId, title, lastMessage, updatedAt, model, starred });
      return acc;
    }, [])
    .slice(0, MAX_RECENT_CONVERSATIONS);
}

export function mobileCardStyle(palette: MobilePalette, extra?: CSSProperties): CSSProperties {
  return {
    background: palette.panelElevated,
    border: `1px solid ${palette.cardBorder}`,
    boxShadow: palette.shadow,
    borderRadius: MOBILE_CARD_RADIUS,
    backdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
    WebkitBackdropFilter: `blur(${MOBILE_GLASS_BLUR}px)`,
    ...extra,
  };
}

export function sectionLabelStyle(palette: MobilePalette): CSSProperties {
  return {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: palette.subduedText,
  };
}

export function mobileFontFamily() {
  return 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
}

export function renderConnectionLabel(status: 'connected' | 'disconnected') {
  return status === 'connected' ? 'Connected' : 'Disconnected';
}

export function formatAboutVersion(version: string) {
  return version.trim() || '0.1.0';
}
