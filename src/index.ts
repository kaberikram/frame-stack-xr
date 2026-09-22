import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { FrameStackSystem } from './frame-stack-system.js';
import { LauncherSystem } from './launcher-system.js';
import { TableTouchSystem } from './table-touch-system.js';

World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions).then((world) => {
  world
    // Registered first so the others can reach it; priority 1 runs it after touch input each frame.
    .registerSystem(FrameStackSystem, { priority: 1 })
    .registerSystem(TableTouchSystem)
    .registerSystem(LauncherSystem);
});
