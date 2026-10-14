import { defineComponents } from '@iwsdk/core';
import { FrameStack } from './frame-stack-component.js';
import { RoomsLook } from './rooms-component.js';
import { SorangLook } from './sorang-component.js';
import { StretchLook } from './stretch-component.js';

export default defineComponents([FrameStack, StretchLook, SorangLook, RoomsLook]);
