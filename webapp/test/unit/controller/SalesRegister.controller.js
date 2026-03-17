/*global QUnit*/

sap.ui.define([
	"com/bgl/app/salesregister/controller/SalesRegister.controller"
], function (Controller) {
	"use strict";

	QUnit.module("SalesRegister Controller");

	QUnit.test("I should test the SalesRegister controller", function (assert) {
		var oAppController = new Controller();
		oAppController.onInit();
		assert.ok(oAppController);
	});

});
