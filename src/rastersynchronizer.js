goog.provide('olcs.RasterSynchronizer');

goog.require('goog.events');

goog.require('olcs.OLImageryProvider');



/**
 * This object takes care of one-directional synchronization of
 * ol3 raster layers to the given Cesium globe.
 * @param {!ol.View} view
 * @param {!ol.Collection} olLayers
 * @param {!Cesium.ImageryLayerCollection} cesiumLayers
 * @constructor
 */
olcs.RasterSynchronizer = function(view, olLayers, cesiumLayers) {
  /**
   * @type {!ol.View}
   * @private
   */
  this.view_ = view;

  /**
   * @type {!ol.Collection}
   * @private
   */
  this.olLayers_ = olLayers;

  /**
   * @type {!Cesium.ImageryLayerCollection}
   * @private
   */
  this.cesiumLayers_ = cesiumLayers;

  /**
   * Map of ol3 layer ids (from goog.getUid) to the Cesium ImageryLayers.
   * null value means, that we are unable to create equivalent layer.
   * @type {Object.<number, ?Cesium.ImageryLayer>}
   * @private
   */
  this.layerMap_ = {};

  goog.events.listen(/** @type {!goog.events.EventTarget} */(this.olLayers_),
      [goog.events.EventType.CHANGE, 'add', 'remove'], function(e) {
        this.synchronize();
      }, false, this);
};


/**
 * Performs complete synchronization of the raster layers.
 */
olcs.RasterSynchronizer.prototype.synchronize = function() {
  var unusedCesiumLayers = goog.object.transpose(this.layerMap_);
  this.cesiumLayers_.removeAll(false);

  var viewProj = this.view_.getProjection();

  var synchronizeLayer = goog.bind(function(olLayer) {
    // handle layer groups
    if (olLayer instanceof ol.layer.Group) {
      var sublayers = olLayer.getLayers();
      if (goog.isDef(sublayers)) {
        sublayers.forEach(function(el, i, arr) {
          synchronizeLayer(el);
        });
      }
      return;
    }

    var olLayerId = goog.getUid(olLayer);
    var cesiumLayer = this.layerMap_[olLayerId];

    // no mapping -> create new layer and set up synchronization
    if (!goog.isDef(cesiumLayer)) {
      cesiumLayer = olcs.RasterSynchronizer.createCorrespondingLayer(olLayer,
                                                                     viewProj);
      olcs.RasterSynchronizer.syncLayerProperties(olLayer, cesiumLayer);
      if (!goog.isNull(cesiumLayer)) {
        goog.events.listen(olLayer,
            ['change:brightness', 'change:contrast', 'change:hue',
             'change:opacity', 'change:saturation', 'change:visible'],
            function(e) {
              olcs.RasterSynchronizer.syncLayerProperties(olLayer, cesiumLayer);
            });

        // there is no way to modify Cesium layer extent,
        // we have to recreate when ol3 layer extent changes:
        goog.events.listen(olLayer, 'change:extent', function(e) {
          this.cesiumLayers_.remove(cesiumLayer, true); // destroy
          delete this.layerMap_[olLayerId]; // invalidate the map entry
          this.synchronize();
        }, false, this);
      }
      this.layerMap_[olLayerId] = cesiumLayer;
    }

    // add Cesium layers
    if (cesiumLayer) {
      this.cesiumLayers_.add(cesiumLayer);
      delete unusedCesiumLayers[cesiumLayer];
    }
  }, this);

  this.olLayers_.forEach(function(el, i, arr) {
    synchronizeLayer(el);
  });

  // destroy unused Cesium ImageryLayers
  goog.array.forEach(goog.object.getValues(unusedCesiumLayers),
      function(el, i, arr) {
        var layerId = el;
        var layer = this.layerMap_[layerId];
        if (goog.isDef(layer)) {
          delete this.layerMap_[layerId];
          layer.destroy();
        }
      }, this);
};


/**
 * @param {!ol.layer.Layer} olLayer
 * @param {?ol.proj.Projection} viewProj Projection of the view.
 * @return {?Cesium.ImageryLayer}
 */
olcs.RasterSynchronizer.createCorrespondingLayer = function(olLayer,
                                                            viewProj) {
  if (!(olLayer instanceof ol.layer.Tile)) {
    return null;
  }

  var provider = null;

  var source = olLayer.getSource();
  // handle special cases before the general synchronization
  if (source instanceof ol.source.WMTS) {
    // WMTS uses different TileGrid which is not currently supported
    return null;
  }
  if (source instanceof ol.source.TileImage) {
    var projection = source.getProjection();

    if (goog.isNull(projection)) {
      // if not explicit, assume the same projection as view
      projection = viewProj;
    } else if (projection !== viewProj) {
      return null; // do not sync layers with projections different than view
    }

    var is3857 = projection === ol.proj.get('EPSG:3857');
    var is4326 = projection === ol.proj.get('EPSG:4326');
    if (is3857 || is4326) {
      provider = new olcs.OLImageryProvider(source, viewProj);
    } else {
      return null;
    }
  } else {
    // sources other than TileImage are currently not supported
    return null;
  }

  // the provider is always non-null if we got this far

  var layerOptions = {};

  var ext = olLayer.getExtent();
  if (goog.isDefAndNotNull(ext) && !goog.isNull(viewProj)) {
    var llExt = ol.proj.transformExtent(ext, viewProj, 'EPSG:4326');
    layerOptions.rectangle = Cesium.Rectangle.fromDegrees(llExt[0], llExt[1],
                                                          llExt[2], llExt[3]);
  }

  var cesiumLayer = new Cesium.ImageryLayer(provider, layerOptions);
  return cesiumLayer;
};


/**
 * Synchronizes the layer rendering properties (brightness, contrast, hue,
 * opacity, saturation, visible) to the given Cesium ImageryLayer.
 * @param {!ol.layer.Layer} olLayer
 * @param {!Cesium.ImageryLayer} csLayer
 */
olcs.RasterSynchronizer.syncLayerProperties = function(olLayer, csLayer) {
  var opacity = olLayer.getOpacity();
  if (goog.isDef(opacity)) {
    csLayer.alpha = opacity;
  }
  var visible = olLayer.getVisible();
  if (goog.isDef(visible)) {
    csLayer.show = visible;
  }

  // saturation and contrast are working ok
  var saturation = olLayer.getSaturation();
  if (goog.isDef(saturation)) {
    csLayer.saturation = saturation;
  }
  var contrast = olLayer.getContrast();
  if (goog.isDef(contrast)) {
    csLayer.contrast = contrast;
  }

  // Cesium actually operates in YIQ space -> hard to emulate
  // The following values are only a rough approximations:

  // The hue in Cesium has different meaning than the OL equivalent.
  // var hue = olLayer.getHue();
  // if (goog.isDef(hue)) {
  //   csLayer.hue = hue;
  // }

  var brightness = olLayer.getBrightness();
  if (goog.isDef(brightness)) {
    // rough estimation
    csLayer.brightness = Math.pow(1 + parseFloat(brightness), 2);
  }
};
