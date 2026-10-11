import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { DebugConsoleSystem, installDebugConsole } from './debug-console.js';
import { FrameStackSystem } from './frame-stack-system.js';
import { LauncherSystem } from './launcher-system.js';
import { RoomStretchSystem } from './room-stretch-system.js';
import { SorangSystem } from './sorang-system.js';
import { TableTouchSystem } from './table-touch-system.js';

// Before World.create, so its own logs, errors and rejections reach the headset panel too.
installDebugConsole();

World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions).then((world) => {
  world
    // Registered first so the others can reach it; priority 1 runs it after touch input each frame.
    .registerSystem(FrameStackSystem, { priority: 1 })
    .registerSystem(TableTouchSystem)
    .registerSystem(RoomStretchSystem)
    // Before the launcher, which reaches it in init.
    .registerSystem(SorangSystem)
    .registerSystem(LauncherSystem)
    // Runs last, so a line logged this frame is drawn this frame.
    .registerSystem(DebugConsoleSystem, { priority: 2 });
});
