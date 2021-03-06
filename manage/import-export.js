/* global messageBox, handleUpdate, applyOnMessage */
'use strict';

const STYLISH_DUMP_FILE_EXT = '.txt';
const STYLUS_BACKUP_FILE_EXT = '.json';


function importFromFile({fileTypeFilter, file} = {}) {
  return new Promise(resolve => {
    const fileInput = document.createElement('input');
    if (file) {
      readFile();
      return;
    }
    fileInput.style.display = 'none';
    fileInput.type = 'file';
    fileInput.accept = fileTypeFilter || STYLISH_DUMP_FILE_EXT;
    fileInput.acceptCharset = 'utf-8';

    document.body.appendChild(fileInput);
    fileInput.initialValue = fileInput.value;
    fileInput.onchange = readFile;
    fileInput.click();

    function readFile() {
      if (file || fileInput.value !== fileInput.initialValue) {
        file = file || fileInput.files[0];
        if (file.size > 100e6) {
          console.warn("100MB backup? I don't believe you.");
          importFromString('').then(resolve);
          return;
        }
        document.body.style.cursor = 'wait';
        const fReader = new FileReader();
        fReader.onloadend = event => {
          fileInput.remove();
          const text = event.target.result;
          const maybeUsercss = !/^[\s\r\n]*\[/.test(text) &&
            (text.includes('==UserStyle==') || /==UserStyle==/i.test(text));
          (!maybeUsercss ?
            importFromString(text) :
            getOwnTab().then(tab => {
              tab.url = URL.createObjectURL(new Blob([text], {type: 'text/css'}));
              return BG.usercssHelper.openInstallPage(tab, {direct: true})
                .then(() => URL.revokeObjectURL(tab.url));
            })
          ).then(numStyles => {
            document.body.style.cursor = '';
            resolve(numStyles);
          });
        };
        fReader.readAsText(file, 'utf-8');
      }
    }
  });
}


function importFromString(jsonString) {
  if (!BG) {
    onBackgroundReady().then(() => importFromString(jsonString));
    return;
  }
  // create objects in background context
  const json = BG.tryJSONparse(jsonString) || [];
  if (typeof json.slice !== 'function') {
    json.length = 0;
  }
  const oldStyles = json.length && BG.deepCopy(BG.cachedStyles.list || []);
  const oldStylesByName = json.length && new Map(
    oldStyles.map(style => [style.name.trim(), style]));

  const stats = {
    added:       {names: [], ids: [], legend: 'importReportLegendAdded'},
    unchanged:   {names: [], ids: [], legend: 'importReportLegendIdentical'},
    metaAndCode: {names: [], ids: [], legend: 'importReportLegendUpdatedBoth'},
    metaOnly:    {names: [], ids: [], legend: 'importReportLegendUpdatedMeta'},
    codeOnly:    {names: [], ids: [], legend: 'importReportLegendUpdatedCode'},
    invalid:     {names: [], legend: 'importReportLegendInvalid'},
  };

  let index = 0;
  let lastRenderTime = performance.now();
  const renderQueue = [];
  const RENDER_NAP_TIME_MAX = 1000; // ms
  const RENDER_QUEUE_MAX = 50; // number of styles
  const SAVE_OPTIONS = {reason: 'import', notify: false};

  return new Promise(proceed);

  function proceed(resolve) {
    while (index < json.length) {
      const item = json[index++];
      const info = analyze(item);
      if (info) {
        // using saveStyle directly since json was parsed in background page context
        return BG.saveStyle(Object.assign(item, SAVE_OPTIONS))
          .then(style => account({style, info, resolve}));
      }
    }
    renderQueue.forEach(style => handleUpdate(style, {reason: 'import'}));
    renderQueue.length = 0;
    done(resolve);
  }

  function analyze(item) {
    if (!item || !item.name || !item.name.trim() || typeof item !== 'object'
    || (item.sections && typeof item.sections.slice !== 'function')) {
      stats.invalid.names.push(`#${index}: ${limitString(item && item.name || '')}`);
      return;
    }
    item.name = item.name.trim();
    const byId = BG.cachedStyles.byId.get(item.id);
    const byName = oldStylesByName.get(item.name);
    oldStylesByName.delete(item.name);
    let oldStyle;
    if (byId) {
      if (sameStyle(byId, item)) {
        oldStyle = byId;
      } else {
        item.id = null;
      }
    }
    if (!oldStyle && byName) {
      item.id = byName.id;
      oldStyle = byName;
    }
    const oldStyleKeys = oldStyle && Object.keys(oldStyle);
    const metaEqual = oldStyleKeys &&
      oldStyleKeys.length === Object.keys(item).length &&
      oldStyleKeys.every(k => k === 'sections' || oldStyle[k] === item[k]);
    const codeEqual = oldStyle && BG.styleSectionsEqual(oldStyle, item);
    if (metaEqual && codeEqual) {
      stats.unchanged.names.push(oldStyle.name);
      stats.unchanged.ids.push(oldStyle.id);
      return;
    }
    return {oldStyle, metaEqual, codeEqual};
  }

  function sameStyle(oldStyle, newStyle) {
    return oldStyle.name.trim() === newStyle.name.trim() ||
      ['updateUrl', 'originalMd5', 'originalDigest']
        .some(field => oldStyle[field] && oldStyle[field] === newStyle[field]);
  }

  function account({style, info, resolve}) {
    renderQueue.push(style);
    if (performance.now() - lastRenderTime > RENDER_NAP_TIME_MAX
    || renderQueue.length > RENDER_QUEUE_MAX) {
      renderQueue.forEach(style => handleUpdate(style, {reason: 'import'}));
      setTimeout(scrollElementIntoView, 0, $('#style-' + renderQueue.pop().id));
      renderQueue.length = 0;
      lastRenderTime = performance.now();
    }
    setTimeout(proceed, 0, resolve);
    const {oldStyle, metaEqual, codeEqual} = info;
    if (!oldStyle) {
      stats.added.names.push(style.name);
      stats.added.ids.push(style.id);
      return;
    }
    if (!metaEqual && !codeEqual) {
      stats.metaAndCode.names.push(reportNameChange(oldStyle, style));
      stats.metaAndCode.ids.push(style.id);
      return;
    }
    if (!codeEqual) {
      stats.codeOnly.names.push(style.name);
      stats.codeOnly.ids.push(style.id);
      return;
    }
    stats.metaOnly.names.push(reportNameChange(oldStyle, style));
    stats.metaOnly.ids.push(style.id);
  }

  function done(resolve) {
    const numChanged = stats.metaAndCode.names.length +
      stats.metaOnly.names.length +
      stats.codeOnly.names.length +
      stats.added.names.length;
    Promise.resolve(numChanged && refreshAllTabs()).then(() => {
      const report = Object.keys(stats)
        .filter(kind => stats[kind].names.length)
        .map(kind => {
          const {ids, names, legend} = stats[kind];
          const listItemsWithId = (name, i) =>
            $create('div', {dataset: {id: ids[i]}}, name);
          const listItems = name =>
            $create('div', name);
          const block =
            $create('details', {dataset: {id: kind}}, [
              $create('summary',
                $create('b', names.length + ' ' + t(legend))),
              $create('small',
                names.map(ids ? listItemsWithId : listItems)),
            ]);
          return block;
        });
      scrollTo(0, 0);
      messageBox({
        title: t('importReportTitle'),
        contents: report.length ? report : t('importReportUnchanged'),
        buttons: [t('confirmOK'), numChanged && t('undo')],
        onshow:  bindClick,
      }).then(({button}) => {
        if (button === 1) {
          undo();
        }
      });
      resolve(numChanged);
    });
  }

  function undo() {
    const oldStylesById = new Map(oldStyles.map(style => [style.id, style]));
    const newIds = [
      ...stats.metaAndCode.ids,
      ...stats.metaOnly.ids,
      ...stats.codeOnly.ids,
      ...stats.added.ids,
    ];
    let resolve;
    index = 0;
    return new Promise(resolve_ => {
      resolve = resolve_;
      undoNextId();
    }).then(refreshAllTabs)
      .then(() => messageBox({
        title: t('importReportUndoneTitle'),
        contents: newIds.length + ' ' + t('importReportUndone'),
        buttons: [t('confirmOK')],
      }));
    function undoNextId() {
      if (index === newIds.length) {
        resolve();
        return;
      }
      const id = newIds[index++];
      deleteStyleSafe({id, notify: false}).then(id => {
        const oldStyle = oldStylesById.get(id);
        if (oldStyle) {
          saveStyleSafe(Object.assign(oldStyle, SAVE_OPTIONS))
            .then(undoNextId);
        } else {
          undoNextId();
        }
      });
    }
  }

  function bindClick() {
    const highlightElement = event => {
      const styleElement = $('#style-' + event.target.dataset.id);
      if (styleElement) {
        scrollElementIntoView(styleElement);
        animateElement(styleElement);
      }
    };
    for (const block of $$('details')) {
      if (block.dataset.id !== 'invalid') {
        block.style.cursor = 'pointer';
        block.onclick = highlightElement;
      }
    }
  }

  function limitString(s, limit = 100) {
    return s.length <= limit ? s : s.substr(0, limit) + '...';
  }

  function reportNameChange(oldStyle, newStyle) {
    return newStyle.name !== oldStyle.name
      ? oldStyle.name + ' —> ' + newStyle.name
      : oldStyle.name;
  }

  function refreshAllTabs() {
    return getOwnTab().then(ownTab => new Promise(resolve => {
      queryTabs().then(tabs => {
        tabs = !FIREFOX ? tabs : tabs.filter(tab => tab.width);
        tabs.forEach((tab, i) =>
          refreshTab(tab, ownTab, (i === tabs.length - 1) && resolve));
        if (!tabs.length) {
          resolve();
        }
      });
    }));
  }

  function refreshTab(tab, ownTab, resolve) {
    const tabId = tab.id;
    chrome.webNavigation.getAllFrames({tabId}, frames => {
      frames = frames && frames[0] ? frames : [{frameId: 0}];
      frames.forEach(({frameId}) =>
        getStylesSafe({matchUrl: tab.url, enabled: true, asHash: true}).then(styles => {
          const message = {method: 'styleReplaceAll', tabId, frameId, styles};
          if (tab.id === ownTab.id) {
            applyOnMessage(message);
          } else {
            invokeOrPostpone(tab.active, sendMessage, message, ignoreChromeError);
          }
          if (frameId === 0) {
            setTimeout(BG.updateIcon, 0, tab, styles);
          }
        }));
      if (resolve) {
        resolve();
      }
      ignoreChromeError();
    });
  }
}


$('#file-all-styles').onclick = () => {
  getStylesSafe().then(styles => {
    const text = JSON.stringify(styles, null, '\t');
    const blob = new Blob([text], {type: 'application/json'});
    const objectURL = URL.createObjectURL(blob);
    let link = $create('a', {
      href: objectURL,
      type: 'application/json',
      download: generateFileName(),
    });
    // TODO: remove the fallback when FF multi-process bug is fixed
    if (!FIREFOX) {
      link.dispatchEvent(new MouseEvent('click'));
      setTimeout(() => URL.revokeObjectURL(objectURL));
    } else {
      const iframe = document.body.appendChild($create('iframe', {
        style: 'width: 0; height: 0; position: fixed; opacity: 0;'.replace(/;/g, '!important;'),
      }));
      doTimeout()
        .then(() => {
          link = iframe.contentDocument.importNode(link, true);
          iframe.contentDocument.body.appendChild(link);
        })
        .then(() => doTimeout())
        .then(() => link.dispatchEvent(new MouseEvent('click')))
        .then(() => doTimeout(1000))
        .then(() => {
          URL.revokeObjectURL(objectURL);
          iframe.remove();
        });
    }
  });

  function doTimeout(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function generateFileName() {
    const today = new Date();
    const dd = ('0' + today.getDate()).substr(-2);
    const mm = ('0' + (today.getMonth() + 1)).substr(-2);
    const yyyy = today.getFullYear();
    return `stylus-${yyyy}-${mm}-${dd}${STYLUS_BACKUP_FILE_EXT}`;
  }
};


$('#unfile-all-styles').onclick = () => {
  importFromFile({fileTypeFilter: STYLUS_BACKUP_FILE_EXT});
};

Object.assign(document.body, {
  ondragover(event) {
    const hasFiles = event.dataTransfer.types.includes('Files');
    event.dataTransfer.dropEffect = hasFiles || event.target.type === 'search' ? 'copy' : 'none';
    this.classList.toggle('dropzone', hasFiles);
    if (hasFiles) {
      event.preventDefault();
      clearTimeout(this.fadeoutTimer);
      this.classList.remove('fadeout');
    }
  },
  ondragend() {
    animateElement(this, {className: 'fadeout', removeExtraClasses: ['dropzone']}).then(() => {
      this.style.animationDuration = '';
    });
  },
  ondragleave(event) {
    try {
      // in Firefox event.target could be XUL browser and hence there is no permission to access it
      if (event.target === this) {
        this.ondragend();
      }
    } catch (e) {
      this.ondragend();
    }
  },
  ondrop(event) {
    this.ondragend();
    if (event.dataTransfer.files.length) {
      event.preventDefault();
      if ($('#only-updates input').checked) {
        $('#only-updates input').click();
      }
      importFromFile({file: event.dataTransfer.files[0]});
    }
  },
});
