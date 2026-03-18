sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/ui/model/json/JSONModel",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/comp/smartvariants/PersonalizableInfo",
    "sap/m/MessageBox",
    "sap/ui/export/library",
    "sap/ui/export/Spreadsheet",
    "sap/m/MessageToast",
    "sap/ui/core/Fragment"
], function (Controller, JSONModel, Filter, FilterOperator, PersonalizableInfo, MessageBox, exportLibrary, Spreadsheet, MessageToast, Fragment) {
    "use strict";

    const EdmType = exportLibrary.EdmType;

    return Controller.extend("com.bgl.app.salesregister.controller.SalesRegister", {

        onInit: function () {
            this._oTable = this.byId("idSalesTable");
            this._oFilterBar = this.byId("filterbar");

            var oTableDataModel = new JSONModel();
            this.getView().setModel(oTableDataModel, "TableDataModel");

            var oDivModel = new JSONModel();
            this.getView().setModel(oDivModel, "DivisionModel");
            this._fetchDivisionData();
        },

        // ─── Validation ───────────────────────────────────────────────────────────
        _validateInputFields: function () {
            var oFromDate  = this.byId("idFromDate");
            var oToDate    = this.byId("idToDate");
            var oDivision  = this.byId("idDivision");
            var isValid    = true;
            var aMessages  = [];

            if (!oFromDate.getValue()) {
                oFromDate.setValueState(sap.ui.core.ValueState.Error);
                isValid = false;
                aMessages.push("From Date");
            } else {
                oFromDate.setValueState(sap.ui.core.ValueState.None);
            }

            if (!oToDate.getValue()) {
                oToDate.setValueState(sap.ui.core.ValueState.Error);
                isValid = false;
                aMessages.push("To Date");
            } else {
                oToDate.setValueState(sap.ui.core.ValueState.None);
            }

            if (!oDivision.getValue()) {
                oDivision.setValueState(sap.ui.core.ValueState.Error);
                isValid = false;
                aMessages.push("Division");
            } else {
                oDivision.setValueState(sap.ui.core.ValueState.None);
            }

            if (!isValid) {
                MessageBox.error("Please fill up the following fields: " + aMessages.join(", "));
            }
            return isValid;
        },

        // ─── Search / OData Call ──────────────────────────────────────────────────
        onSearch: function () {
            if (!this._validateInputFields()) {
                return;
            }

            var oModel = this.getOwnerComponent().getModel(); // mainService
            var sFrom  = this.byId("idFromDate").getValue();  // yyyy-MM-dd
            var sTo    = this.byId("idToDate").getValue();
            var sDiv   = this.byId("idDivision").getValue();

            /*
             * FIX: "Invalid URI segment"
             * ─────────────────────────────────────────────────────────────────────
             * ZI_SALEREG_BASE is a ABAP CDS table function / OData function import.
             * OData V2 function imports must be called via oModel.callFunction(),
             * NOT via oModel.read() with an entity-key style path.
             *
             * If the backend exposes it as a plain EntitySet (no parameters in key),
             * use oModel.read("/ZI_SALEREG_BASE_Set", { filters: [...] }) instead.
             * Choose ONE of the two approaches below and delete the other.
             * ─────────────────────────────────────────────────────────────────────
             */

            sap.ui.core.BusyIndicator.show(0);

            // Clear previous results before every new search
            this.getView().getModel("TableDataModel").setData({ results: [] });

            /*
             * Metadata analysis:
             * ─────────────────────────────────────────────────────────────────────
             * EntitySet "ZI_SALEREG_BASE"    → type ZI_SALEREG_BASEParameters
             *   Key: p_from_date (Edm.DateTime), p_to_date (Edm.DateTime), p_division (Edm.String)
             *   NavigationProperty "Set"     → ZI_SALEREG_BASESet (actual data rows)
             *
             * FIX: Use oModel.createKey() so the OData library reads the metadata and
             * formats Edm.DateTime key values correctly (datetime'...') with proper
             * encoding — manual string concatenation caused the "Invalid URI segment" error.
             * ─────────────────────────────────────────────────────────────────────
             */
            var sParamKey = oModel.createKey("/ZI_SALEREG_BASE", {
                p_from_date : new Date(sFrom + "T00:00:00"),
                p_to_date   : new Date(sTo   + "T00:00:00"),
                p_division  : sDiv
            });

            // Navigate from Parameters entity to the actual result Set
            var sPath = sParamKey + "/Set";

            oModel.read(sPath, {
                success: function (oData) {
                    sap.ui.core.BusyIndicator.hide();

                    var aResults = (oData && oData.results) ? oData.results : [];

                    // ── No data handling ──────────────────────────────────────────
                    if (aResults.length === 0) {
                        this.getView().getModel("TableDataModel").setData({ results: [] });
                        MessageBox.information(
                            "No records found for the selected criteria.\n\n" +
                            "From Date : " + this.byId("idFromDate").getValue() + "\n" +
                            "To Date   : " + this.byId("idToDate").getValue()   + "\n" +
                            "Division  : " + this.byId("idDivision").getValue(),
                            { title: "No Data Found" }
                        );
                        return;
                    }

                    // ── Append Grand Total row ────────────────────────────────────
                    var oTotal = this._computeGrandTotal(aResults);
                    aResults.push(oTotal);

                    this.getView().getModel("TableDataModel").setData({ results: aResults });
                }.bind(this),

                error: function (oError) {
                    sap.ui.core.BusyIndicator.hide();
                    // Clear table on error so stale data is not visible
                    this.getView().getModel("TableDataModel").setData({ results: [] });

                    var sMsg = this._parseODataError(oError);
                    MessageBox.error(sMsg, {
                        title: "Error",
                        details: oError.responseText || "",
                        styleClass: this.getOwnerComponent().getContentDensityClass
                            ? this.getOwnerComponent().getContentDensityClass()
                            : ""
                    });
                }.bind(this)
            });
        },

        // ─── Grand Total Row Builder ──────────────────────────────────────────────
        /**
         * Iterates all data rows, sums every numeric value field, and returns a
         * synthetic "Grand Total" row object that can be pushed into the results array.
         * Percentage fields (IgstPer, CgstPer, SgstPer, TcsPer, TaxRatePer) are NOT
         * summed — they are left blank in the total row.
         */
        _computeGrandTotal: function (aRows) {
            var aSumFields = [
                "BillingQuantity",
                "PriceToUpdate", "TradeMargin", "DiscountExcl", "ExciseDutySt",
                "TaxableValue",  "EdRecovery",  "ExciseDuty",  "NetTaxableValue",
                "TaxVatRs",
                "Igst",  "Cgst",  "Sgst",  "Tcs",
                "TaxAmount", "InvoiceValue",
                "DailyAuthQty"
            ];

            // Initialise totals to 0
            var oTotal = { IsGrandTotal: true };
            aSumFields.forEach(function (sField) { oTotal[sField] = 0; });

            // Accumulate — skip any existing grand total row, parseFloat handles string decimals
            aRows.forEach(function (oRow) {
                if (oRow.IsGrandTotal) { return; }  // skip previous grand total on re-search
                aSumFields.forEach(function (sField) {
                    oTotal[sField] += parseFloat(oRow[sField]) || 0;
                });
            });

            // Round all totals to 2 decimal places (3 for quantity fields)
            var aQtyFields = ["BillingQuantity", "DailyAuthQty"];
            aSumFields.forEach(function (sField) {
                var iDecimals = aQtyFields.indexOf(sField) !== -1 ? 3 : 2;
                oTotal[sField] = oTotal[sField].toFixed(iDecimals);
            });

            // ── Text/label fields ─────────────────────────────────────────────
            oTotal.BillingDocumentDate       = null;
            oTotal.InvoiceMonthName          = "";
            oTotal.FiscalYear                = "";
            oTotal.BillingDocument           = "Grand Total";
            oTotal.BillingDocumentItem       = "";
            oTotal.BillingDocumentTypeText   = "";
            oTotal.OverallBillingStatus      = "";
            oTotal.SalesDistrictName         = "";
            oTotal.SalesGroupName            = "";
            oTotal.CustomerGroupName         = "";
            oTotal.ProfitCenter              = "";
            oTotal.SoldToParty               = "";   // FIX: was missing
            oTotal.SoldToName                = "";   // FIX: was missing
            oTotal.ShipToParty               = "";
            oTotal.ShipToName                = "";
            oTotal.Plant                     = "";
            oTotal.Material                  = "";
            oTotal.BillingDocumentItemText   = "";
            oTotal.BillingQuantityUnit       = "";
            oTotal.SalesOrderDistributionChannel = "";
            oTotal.DailyAuthUnit             = "";
            oTotal["class"]                  = "";
            oTotal.TransactionCurrency       = "";

            // ── FIX: Float-bound % fields must be null, NOT ""  ──────────────
            // sap.ui.model.type.Float throws FormatException on empty string
            // which can prevent the grand total row from rendering.
            // null is handled gracefully — the cell just shows blank.
            oTotal.TaxRatePer  = null;
            oTotal.IgstPer     = null;
            oTotal.CgstPer     = null;
            oTotal.SgstPer     = null;
            oTotal.TcsPer      = null;

            return oTotal;
        },

        // ─── Centralised OData Error Parser ──────────────────────────────────────
        /**
         * Extracts a human-readable message from any OData V2 error response.
         * Handles: JSON body, XML body, network/timeout errors, and unknown shapes.
         */
        _parseODataError: function (oError) {
            // 1. Network / timeout — no responseText at all
            if (!oError.responseText && !oError.response) {
                return "A network error occurred. Please check your connection and try again.";
            }

            var sRaw = oError.responseText
                || (oError.response && oError.response.body)
                || "";

            // 2. JSON error body  {"error":{"message":{"value":"..."}}}
            if (sRaw) {
                try {
                    var oJson = JSON.parse(sRaw);
                    if (oJson.error) {
                        var sInner = oJson.error.message && oJson.error.message.value
                            ? oJson.error.message.value
                            : JSON.stringify(oJson.error);

                        // Append inner-error details when present (SAP-specific)
                        if (oJson.error.innererror && oJson.error.innererror.errordetails) {
                            var aDetails = oJson.error.innererror.errordetails
                                .filter(function (d) { return d.message; })
                                .map(function (d) { return "• " + d.message; });
                            if (aDetails.length) {
                                sInner += "\n\nDetails:\n" + aDetails.join("\n");
                            }
                        }
                        return sInner;
                    }
                } catch (eJson) { /* not JSON — fall through */ }

                // 3. XML error body  <message>...</message>
                try {
                    var oParser  = new DOMParser();
                    var oXmlDoc  = oParser.parseFromString(sRaw, "application/xml");
                    var oMsgNode = oXmlDoc.querySelector("message");
                    if (oMsgNode && oMsgNode.textContent) {
                        return oMsgNode.textContent;
                    }
                } catch (eXml) { /* not XML — fall through */ }
            }

            // 4. HTTP status fallback
            var iStatus = oError.statusCode
                || (oError.response && oError.response.statusCode)
                || 0;

            var mStatusMessages = {
                400: "Bad Request — please check your input parameters.",
                401: "Unauthorised — your session may have expired. Please refresh and log in again.",
                403: "Forbidden — you do not have permission to perform this action.",
                404: "Resource not found — the requested data does not exist.",
                408: "Request timed out — the server took too long to respond. Please try again.",
                500: "Internal Server Error — please contact your system administrator.",
                503: "Service Unavailable — the backend is temporarily down. Please try again later."
            };

            return mStatusMessages[iStatus]
                || ("An unexpected error occurred (HTTP " + (iStatus || "unknown") + "). Please try again or contact support.");
        },

        // ─── Division F4 Value Help ───────────────────────────────────────────────
        onDivisionValueHelp: function () {
            var oView = this.getView();
            if (!this._oDivDialog) {
                Fragment.load({
                    id: oView.getId(),
                    name: "com.bgl.app.salesregister.Fragment.DivisionF4",
                    controller: this
                }).then(function (oDialog) {
                    this._oDivDialog = oDialog;
                    oView.addDependent(this._oDivDialog);
                    // this._fetchDivisionData();
                    this._oDivDialog.open();
                }.bind(this));
            } else {
                this._oDivDialog.open();
            }
        },

        _fetchDivisionData: function () {
            var oModel = this.getOwnerComponent().getModel();
            oModel.read("/I_Division", {
                success: function (oData) {
                    this.getView().getModel("DivisionModel").setData(oData.results);
                }.bind(this)
            });
        },

        onValueHelpConfirm: function (oEvent) {
            var oSelectedItem = oEvent.getParameter("selectedItem");
            if (oSelectedItem) {
                this.byId("idDivision").setValue(oSelectedItem.getTitle());
            }
        },

        // ─── Excel Export ─────────────────────────────────────────────────────────
        onExport: function () {
            var oSettings = {
                workbook: { columns: this._createColumnConfig() },
                dataSource: this.byId("idSalesTable").getBinding("items"),
                fileName: "Sales_Register_Report.xlsx",
                worker: false
            };
            var oSheet = new Spreadsheet(oSettings);
            oSheet.build().finally(function () { oSheet.destroy(); });
        },

        // ─── Column Config (all 43 required columns) ──────────────────────────────
        _createColumnConfig: function () {
            return [
                // ── Core / Green columns ──────────────────────────────────────────
                { label: "Invoice Date",                   property: "BillingDocumentDate",               type: EdmType.Date },
                { label: "Invoice Month",                  property: "InvoiceMonthName",                  type: EdmType.String },
                { label: "Fiscal Year",                    property: "FiscalYear",                        type: EdmType.String },
                { label: "Invoice No",                     property: "BillingDocument",                   type: EdmType.String },
                { label: "Sold To Code",                   property: "SoldToParty",                       type: EdmType.String },
                { label: "Sold To Name",                   property: "SoldToName",                        type: EdmType.String },
                { label: "Sale Type",                      property: "BillingDocumentTypeText",           type: EdmType.String },
                { label: "Billing Document Status",        property: "OverallBillingStatus",              type: EdmType.String },
                { label: "Sales District (Charge Area)",   property: "SalesDistrictName",                 type: EdmType.String },
                { label: "Acct Assmt Grp Cust./Sales Grp", property: "SalesGroupName",                   type: EdmType.String },
                { label: "Customer Type",                  property: "CustomerGroupName",                 type: EdmType.String },
                { label: "Item",                           property: "BillingDocumentItem",               type: EdmType.String },
                { label: "Profit Centre",                  property: "ProfitCenter",                      type: EdmType.String },
                { label: "Ship To Code",                   property: "ShipToParty",                       type: EdmType.String },
                { label: "Ship To Name",                   property: "ShipToName",                        type: EdmType.String },
                { label: "GA of BGL",                      property: "Plant",                             type: EdmType.String },
                { label: "Material Code",                  property: "Material",                          type: EdmType.String },
                { label: "Material Name",                  property: "BillingDocumentItemText",           type: EdmType.String },
                { label: "Billing Quantity",               property: "BillingQuantity",                   type: EdmType.Decimal, scale: 3 },
                { label: "Billing UOM",                    property: "BillingQuantityUnit",               type: EdmType.String },

                // ── Pricing / Yellow columns ──────────────────────────────────────
                { label: "Price to Update",                property: "PriceToUpdate",                     type: EdmType.Decimal, scale: 2 },
                { label: "Trade Margin",                   property: "TradeMargin",                       type: EdmType.Decimal, scale: 2 },
                { label: "Discount Excluding",             property: "DiscountExcl",                      type: EdmType.Decimal, scale: 2 },
                { label: "Excise Duty ST",                 property: "ExciseDutySt",                      type: EdmType.Decimal, scale: 2 },
                { label: "Taxable Value (Rs.)",            property: "TaxableValue",                      type: EdmType.Decimal, scale: 2 },
                { label: "ED Recovery",                    property: "EdRecovery",                        type: EdmType.Decimal, scale: 2 },
                { label: "Excise Duty",                    property: "ExciseDuty",                        type: EdmType.Decimal, scale: 2 },
                { label: "Net Taxable Value (Rs.)",        property: "NetTaxableValue",                   type: EdmType.Decimal, scale: 2 },
                { label: "Tax Rate % (VAT)",               property: "TaxRatePer",                        type: EdmType.Decimal, scale: 2 },
                { label: "Tax (Rs.) - VAT",                property: "TaxVatRs",                          type: EdmType.Decimal, scale: 2 },
                { label: "IGST",                           property: "Igst",                              type: EdmType.Decimal, scale: 2 },
                { label: "IGST %",                         property: "IgstPer",                           type: EdmType.Decimal, scale: 2 },
                { label: "CGST",                           property: "Cgst",                              type: EdmType.Decimal, scale: 2 },
                { label: "CGST %",                         property: "CgstPer",                           type: EdmType.Decimal, scale: 2 },
                { label: "SGST",                           property: "Sgst",                              type: EdmType.Decimal, scale: 2 },
                { label: "SGST %",                         property: "SgstPer",                           type: EdmType.Decimal, scale: 2 },
                { label: "TCS",                            property: "Tcs",                               type: EdmType.Decimal, scale: 2 },
                { label: "TCS %",                          property: "TcsPer",                            type: EdmType.Decimal, scale: 2 },

                // ── Summary / Green columns ───────────────────────────────────────
                { label: "Invoice Value (Rs.)",            property: "InvoiceValue",                      type: EdmType.Decimal, scale: 2 },
                { label: "Class",                          property: "class",                             type: EdmType.String },
                { label: "Distribution Channel",           property: "SalesOrderDistributionChannel",     type: EdmType.String },
                { label: "Daily Authorized Quantity",      property: "DailyAuthQty",                      type: EdmType.Decimal, scale: 3 },
                { label: "Daily Authorized Quantity (UOM)",property: "DailyAuthUnit",                     type: EdmType.String }
            ];
        }
    });
});