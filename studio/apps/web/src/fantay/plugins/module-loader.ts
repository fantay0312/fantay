// SPDX-License-Identifier: AGPL-3.0-only
// Loads a tool plugin's client module. The file format is the DeepSeek Harness one: a plain script
// that calls
//
//   window.__ModuleLoader__.load({ id: '<package name>', factory(require) { …; return plugin } })
//
// `require` hands out the modules the workspace shares with plugins. React has to be the workspace's
// own copy, which is why plugins take it from here instead of bundling one.
import * as cordis from '@deepseek-ai/cordis';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import type { OpenDesignHostToolPluginClientModule } from '@open-design/host';

interface ClientBundleRegistration {
  id: string;
  factory: (require: ClientBundleRequire) => unknown;
}

interface ClientBundleRequire {
  (specifier: string): unknown;
  async(specifier: string): Promise<unknown>;
  asset(reference: string): string;
}

interface ModuleLoaderFacade {
  mode: 'live';
  load(registration: ClientBundleRegistration): void;
}

declare global {
  interface Window {
    __ModuleLoader__?: ModuleLoaderFacade;
  }
}

const SHARED_MODULES: Record<string, unknown> = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  '@deepseek-ai/cordis': cordis,
};

const registrations = new Map<string, ClientBundleRegistration>();

function installFacade(): void {
  if (window.__ModuleLoader__) return;
  window.__ModuleLoader__ = {
    mode: 'live',
    load(registration) {
      if (!registration || typeof registration.id !== 'string' || typeof registration.factory !== 'function') {
        throw new TypeError('__ModuleLoader__.load needs { id, factory }');
      }
      registrations.set(registration.id.replace(/\/client$/, ''), registration);
    },
  };
}

function createRequire(pluginId: string): ClientBundleRequire {
  const require = ((specifier: string) => {
    if (specifier in SHARED_MODULES) return SHARED_MODULES[specifier];
    throw new Error(`require("${specifier}") is not a module Fantay shares with plugins`);
  }) as ClientBundleRequire;
  require.async = specifier => Promise.reject(new Error(`${pluginId}: require.async("${specifier}") is not available in Fantay`));
  require.asset = reference => reference;
  return require;
}

/**
 * Runs the client module and returns what its factory exports (a Cordis plugin). Style elements the
 * factory adds are tagged `data-plugin`, so `removePluginStyles` can take them out again.
 */
export function evaluateClientModule(module: OpenDesignHostToolPluginClientModule): unknown {
  installFacade();
  registrations.delete(module.moduleId);
  const source = `${module.code}\n//# sourceURL=fantay-plugin:///${encodeURIComponent(module.id)}/client.js?rev=${encodeURIComponent(module.rev)}`;
  // The module is a classic script that expects the global scope.
  new Function(source)();
  const registration = registrations.get(module.moduleId);
  registrations.delete(module.moduleId);
  if (!registration) throw new Error(`The client module did not call __ModuleLoader__.load({ id: "${module.moduleId}" })`);
  const before = new Set(document.head.querySelectorAll('style'));
  try {
    const exported = registration.factory(createRequire(module.id)) as { default?: unknown } | null | undefined;
    return exported?.default ?? exported;
  } finally {
    for (const style of document.head.querySelectorAll('style')) {
      if (!before.has(style) && !style.hasAttribute('data-plugin')) style.setAttribute('data-plugin', module.id);
    }
  }
}

export function removePluginStyles(pluginId: string): void {
  for (const style of document.head.querySelectorAll('style[data-plugin]')) {
    if (style.getAttribute('data-plugin') === pluginId) style.remove();
  }
}
