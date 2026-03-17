/* global QUnit */
QUnit.config.autostart = false;

sap.ui.require(["com/bgl/app/salesregister/test/integration/AllJourneys"
], function () {
	QUnit.start();
});
