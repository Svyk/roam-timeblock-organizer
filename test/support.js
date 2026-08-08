export function installBrowserMocks() {
  const calls = [];
  const target = new EventTarget();
  const documentTarget = new EventTarget();
  Object.defineProperty(documentTarget, "visibilityState", { value: "visible", writable: true });
  const commandPalette = { addCommand: (command) => calls.push(["command:add", command.label, command.callback]), removeCommand: ({ label }) => calls.push(["command:remove", label]) };
  Object.assign(target, {
    roamAlphaAPI: {
      q: () => [],
      data: {
        q: () => [], pull: () => null,
        async: { pull: (...args) => Promise.resolve(target.roamAlphaAPI.data.pull(...args)) },
        addPullWatch: (...args) => calls.push(["watch:add", ...args]), removePullWatch: (...args) => calls.push(["watch:remove", ...args]),
        page: { create: async (...args) => calls.push(["page:create", ...args]) },
        block: {
          create: async (...args) => calls.push(["block:create", ...args]),
          update: async (...args) => calls.push(["block:update", ...args]),
          delete: async (...args) => calls.push(["block:delete", ...args]),
          move: async (...args) => calls.push(["block:move", ...args]),
          reorderBlocks: async (...args) => calls.push(["block:reorder", ...args]),
        },
      },
      util: {
        generateUID: (() => { let id = 0; return () => `test${++id}`; })(),
        dateToPageUid: (date) => date.toISOString().slice(0, 10),
      },
      ui: {
        commandPalette,
        getFocusedBlock: () => null,
        mainWindow: { getOpenPageOrBlockUid: async () => null },
        rightSidebar: { addWindow: async () => null },
      },
    },
    alert: () => {}, confirm: () => false,
  });
  const values = new Map();
  globalThis.window = target;
  globalThis.document = documentTarget;
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
  globalThis.alert = target.alert; globalThis.confirm = target.confirm;
  return { calls, document: documentTarget, localValues: values };
}

export function extensionApi(calls, initial = {}, canSet = true) {
  const values = new Map(Object.entries(initial));
  return { values, settings: { canSet, get: (key) => values.get(key) ?? null, getAll: () => Object.fromEntries(values), set: async (key, value) => { calls.push(["setting:set", key, value]); values.set(key, value); }, panel: { create: async (config) => calls.push(["panel:create", config]) } }, ui: { commandPalette: { addCommand: (command) => calls.push(["command:add", command.label, command.callback]), removeCommand: ({ label }) => calls.push(["command:remove", label]) } } };
}
