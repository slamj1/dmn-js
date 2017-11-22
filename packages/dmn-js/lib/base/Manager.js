import EventBus from 'diagram-js/lib/core/EventBus';

import DmnModdle from 'dmn-moddle';

import domify from 'domify';

import domQuery from 'min-dom/lib/query';
import domRemove from 'min-dom/lib/remove';

import debounce from 'lodash/function/debounce';


/**
 * The base class for DMN viewers and editors.
 *
 * @abstract
 */
export default class Manager {

  /**
   * Create a new instance with the given options.
   *
   * @param  {Object} options
   *
   * @return {Manager}
   */
  constructor(options={}) {
    this._eventBus = new EventBus();

    this._viewsChanged = debounce(this._viewsChanged, 100);

    this._views = [];
    this._viewers = {};

    this._init(options);
  }

  /**
   * Parse and render a DMN 1.1 diagram.
   *
   * Once finished the viewer reports back the result to the
   * provided callback function with (err, warnings).
   *
   * ## Life-Cycle Events
   *
   * During import the viewer will fire life-cycle events:
   *
   *   * import.parse.start (about to read model from xml)
   *   * import.parse.complete (model read; may have worked or not)
   *   * import.render.start (graphical import start)
   *   * import.render.complete (graphical import finished)
   *   * import.done (everything done)
   *
   * You can use these events to hook into the life-cycle.
   *
   * @param {String} xml the DMN 1.1 xml
   * @param {Object} [options]
   * @param {Boolean} [options.open=true]
   * @param {Function} [done] invoked with (err, warnings=[])
   */
  importXML(xml, options, done) {

    if (typeof options !== 'object') {
      done = options;
      options = { open: true };
    }

    if (typeof done !== 'function') {
      done = noop;
    }

    // hook in pre-parse listeners +
    // allow xml manipulation
    xml = this._emit('import.parse.start', { xml: xml }) || xml;

    this._moddle.fromXML(xml, 'dmn:Definitions', (err, definitions, context) => {

      // hook in post parse listeners +
      // allow definitions manipulation
      definitions = this._emit('import.parse.complete', {
        error: err,
        definitions: definitions,
        context: context
      }) || definitions;

      var parseWarnings = context.warnings;

      this._setDefinitions(definitions);

      if (err) {
        err = checkValidationError(err);
      }

      if (err || !options.open) {
        this._emit('import.done', { error: err, warmings: parseWarnings });

        return done(err, parseWarnings);
      }

      var view = this._activeView || this._getInitialView(this._views);

      if (!view) {
        return done(new Error('no view to display'));
      }

      this.open(view, (err, warnings) => {

        var allWarnings = [].concat(parseWarnings, warnings);

        this._emit('import.done', { error: err, warnings: allWarnings });

        done(err, allWarnings);
      });
    });
  }

  /**
   * Return active view.
   *
   * @return {View}
   */
  getActiveView() {
    return this._activeView;
  }

  /**
   * Get the currently active viewer instance.
   *
   * @return {View}
   */
  getActiveViewer() {
    var activeView = this.getActiveView();

    return activeView && this._getViewer(activeView);
  }

  getView(element) {
    return this._views.filter(function(v) {
      return v.element === element;
    })[0];
  }

  getViews() {
    return this._views;
  }

  /**
   * Export the currently displayed DMN 1.1 diagram as
   * a DMN 1.1 XML document.
   *
   * @param {Object} [options] export options
   * @param {Boolean} [options.format=false] output formated XML
   * @param {Boolean} [options.preamble=true] output preamble
   * @param {Function} done invoked with (err, xml)
   */
  saveXML(options, done) {

    if (typeof options === 'function') {
      done = options;
      options = {};
    }

    var definitions = this._definitions;

    if (!definitions) {
      return done(new Error('no definitions loaded'));
    }

    this._moddle.toXML(definitions, options, done);
  }

  /**
   * Register an event listener
   *
   * Remove a previously added listener via {@link #off(event, callback)}.
   *
   * @param {String} event
   * @param {Number} [priority]
   * @param {Function} callback
   * @param {Object} [that]
   */
  on(...args) {
    this._eventBus.on(...args);
  }

  /**
   * De-register an event listener
   *
   * @param {String} event
   * @param {Function} callback
   */
  off(...args) {
    this._eventBus.off(...args);
  }

  /**
   * Register a listener to be invoked once only.
   *
   * @param {String} event
   * @param {Number} [priority]
   * @param {Function} callback
   * @param {Object} [that]
   */
  once(...args) {
    this._eventBus.once(...args);
  }

  attachTo(parentNode) {

    // unwrap jQuery if provided
    if (parentNode.get && parentNode.constructor.prototype.jquery) {
      parentNode = parentNode.get(0);
    }

    if (typeof parentNode === 'string') {
      parentNode = domQuery(parentNode);
    }

    parentNode.appendChild(this._container);
  }

  detach() {
    domRemove(this._container);
  }

  destroy() {
    Object.keys(this._viewers, (viewerId) => {
      var viewer = this._viewers[viewerId];

      safeExecute(viewer, 'destroy');
    });

    domRemove(this._container);
  }

  _init(options) {
    this._options = options;

    this._moddle = this._createModdle(options);

    this._viewers = {};
    this._views = [];

    this._container = domify('<div class="dmn-js-parent"></div>');

    if (options.container) {
      this.attachTo(options.container);
    }
  }

  /**
   * Open diagram element.
   *
   * @param  {ModdleElement}   element
   * @param  {Function} [done]
   */
  open(view, done=noop) {
    this._switchView(view, done);
  }

  _setDefinitions(definitions) {
    this._definitions = definitions;

    this._updateViews();
  }

  _viewsChanged() {
    this._emit('views.changed', {
      views: this._views,
      activeView: this._activeView
    });
  }

  /**
   * Recompute changed views after elements in
   * the DMN diagram have changed.
   */
  _updateViews() {

    var definitions = this._definitions;

    if (!definitions) {
      this._views = [];
      this._switchView(null);

      return;
    }

    var viewProviders = this._getViewProviders();

    var displayableElements = [ definitions, ...(definitions.drgElements || []) ];

    // compute list of available views
    this._views = displayableElements.reduce((views, element) => {

      var provider = find(viewProviders, function(provider) {
        return provider.opens === element.$type;
      });

      if (!provider) {
        return views;
      }

      var view = {
        element,
        provider
      };

      return [
        ...views,
        view
      ];
    }, []);

    var activeView = this._activeView,
        newActiveView;

    if (activeView) {
      // check the new active view
      newActiveView = find(this._views, function(v) {
        return viewsEqual(activeView, v);
      }) || this._views[0];

      if (viewsEqual(activeView, newActiveView)) {
        // active view changed
        this._activeView = newActiveView;
      } else {
        // active view got deleted
        return this._switchView(null);
      }
    }

    this._viewsChanged();
  }

  _getInitialView(views) {
    return views[0];
  }

  /**
   * Switch to another view.
   *
   * @param  {View} newView
   * @param  {Function} [done]
   */
  _switchView(newView, done=noop) {

    var complete = (err, warnings) => {
      this._viewsChanged();

      done(err, warnings);
    };

    var activeView = this.getActiveView(),
        activeViewer;

    var newViewer = newView && this._getViewer(newView),
        element = newView && newView.element;

    if (activeView) {
      activeViewer = this._getViewer(activeView);

      if (activeViewer !== newViewer) {
        safeExecute(activeViewer, 'clear');

        activeViewer.detach();
      }
    }

    if (newViewer) {
      this._activeView = newView;

      if (activeViewer !== newViewer) {
        newViewer.attachTo(this._container);
      }

      this._emit('import.render.start', {
        view: newView,
        element: element
      });

      return newViewer.open(element, (err, warnings) => {

        this._emit('import.render.complete', {
          view: newView,
          error: err,
          warnings: warnings
        });

        complete(err, warnings);
      });
    }

    // no active view
    complete();
  }

  _getViewer(view) {

    var provider = view.provider;

    var providerId = provider.id;

    var viewer = this._viewers[providerId];
    var Viewer = provider.constructor;

    if (!viewer) {
      var providerOptions = this._options[providerId] || {};

      viewer = this._viewers[providerId] = new Viewer({
        ...providerOptions,
        moddle: this._moddle,
        additionalModules: [
          ...(providerOptions.additionalModules || []), {
            _parent: [ 'value', this ]
          }
        ]
      });

      // TODO(nikku): wire changed events
    }

    return viewer;
  }

  /**
   * Emit an event.
   */
  _emit(...args) {
    this._eventBus.fire(...args);
  }

  _createModdle(options) {
    return new DmnModdle(options.moddleExtensions || {});
  }

  /**
   * Return the list of available view providers.
   *
   * @abstract
   *
   * @return {Array<ViewProvider>}
   */
  _getViewProviders() {
    return [];
  }

}


/////////// helpers ////////////////////////////////

function noop() {}

function checkValidationError(err) {

  // check if we can help the user by indicating wrong DMN 1.1 xml
  // (in case he or the exporting tool did not get that right)

  var pattern = /unparsable content <([^>]+)> detected([\s\S]*)$/,
      match = pattern.exec(err.message);

  if (match) {
    err.message =
      'unparsable content <' + match[1] + '> detected; ' +
      'this may indicate an invalid DMN 1.1 diagram file' + match[2];
  }

  return err;
}

function find(arr, fn) {
  return arr.filter(fn)[0];
}


function viewsEqual(a, b) {

  if (typeof a === 'undefined') {
    if (typeof b === 'undefined') {
      return true;
    } else {
      return false;
    }
  }

  if (typeof b === 'undefined') {
    return false;
  }

  // compare by element _or_ element ID equality
  return a.element === b.element || a.element.id === b.element.id;
}

function safeExecute(viewer, method) {
  if (typeof viewer[method] === 'function') {
    viewer[method]();
  }
}