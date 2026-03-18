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

            this.oSmartVariantManagement = this.getView().byId("svm");
            this.oExpandedLabel = this.getView().byId("expandedLabel");
            this.oSnappedLabel = this.getView().byId("snappedLabel");

            this._oFilterBar.registerFetchData(this.fetchData);
            this._oFilterBar.registerApplyData(this.applyData);
            this._oFilterBar.registerGetFiltersWithValues(this.getFiltersWithValues);

            var oPersInfo = new PersonalizableInfo({
                type: "filterBar",
                keyName: "persistencyKey",
                dataSource: "",
                control: this._oFilterBar
            });
            this.oSmartVariantManagement.addPersonalizableControl(oPersInfo);
            this.oSmartVariantManagement.initialise(function () { }, this._oFilterBar);

            var oTableDataModel = new JSONModel();
            this.getView().setModel(oTableDataModel, "TableDataModel");

            var oDivModel = new JSONModel();
            this.getView().setModel(oDivModel, "DivisionModel");

            this._bAllPagesLoaded = false;
            this._fetchDivisionData();
        },
        fetchData: function () { return {}; },
        applyData: function () { },
        getFiltersWithValues: function () { return []; },

        // ─── Validation ───────────────────────────────────────────────────────────
        _validateInputFields: function () {
            var oFromDate = this.byId("idFromDate");
            var oToDate = this.byId("idToDate");
            var oDivision = this.byId("idDivision");
            var isValid = true;
            var aMessages = [];

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
        onDateChange: function (oEvent) {
            var oFromDate = this.byId("idFromDate");
            var oToDate = this.byId("idToDate");
            var sFrom = oFromDate.getValue();
            var sTo = oToDate.getValue();

            if (!sFrom || !sTo) {
                oFromDate.setValueState(sap.ui.core.ValueState.None);
                oToDate.setValueState(sap.ui.core.ValueState.None);
                return;
            }

            var dFrom = new Date(sFrom);
            var dTo = new Date(sTo);

            if (dFrom > dTo) {
                // Clear whichever field the user just changed
                var oSource = oEvent.getSource();
                oSource.setValue("");
                oSource.setValueState(sap.ui.core.ValueState.Error);
                oSource.setValueStateText(
                    oSource === oFromDate
                        ? "From Date cannot be later than To Date"
                        : "To Date cannot be earlier than From Date"
                );
            } else {
                oFromDate.setValueState(sap.ui.core.ValueState.None);
                oToDate.setValueState(sap.ui.core.ValueState.None);
            }
        },
        // onDateChange: function () {
        //     var oFromDate = this.getView().byId("idFromDate");
        //     var oToDate = this.getView().byId("idToDate");

        //     var sFromDate = oFromDate.getDateValue();
        //     var sToDate = oToDate.getDateValue();

        //     if (sFromDate && sToDate) {
        //         if (sToDate < sFromDate) {
        //             sap.m.MessageBox.error("To Date cannot be earlier than From Date.");
        //             oToDate.setValue("");
        //         }
        //     }
        // },

        // ─── Search / OData Call ──────────────────────────────────────────────────

        onSearch: function () {
            if (!this._validateInputFields()) {
                return;
            }

            var oModel = this.getOwnerComponent().getModel(); // mainService
            var sFrom = this.byId("idFromDate").getValue();  // yyyy-MM-dd
            var sTo = this.byId("idToDate").getValue();
            var sDiv = this.byId("idDivision").getValue();

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
            this._bAllPagesLoaded = false;
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
            // Use UTC midnight to avoid timezone shift (IST = UTC+5:30 subtracts date by 1)
            var aParts = sFrom.split("-");
            var aToParts = sTo.split("-");

            var sParamKey = oModel.createKey("/ZI_SALEREG_BASE", {
                p_from_date: new Date(Date.UTC(
                    parseInt(aParts[0]), parseInt(aParts[1]) - 1, parseInt(aParts[2])
                )),
                p_to_date: new Date(Date.UTC(
                    parseInt(aToParts[0]), parseInt(aToParts[1]) - 1, parseInt(aToParts[2])
                )),
                p_division: sDiv
            });

            // Navigate from Parameters entity to the actual result Set
            var sPath = sParamKey + "/Set";

            console.log(sPath);

            // ── Paginated read with $skiptoken support ────────────────────
            var aAllResults = [];
            var that = this;

            function readPage(sSkipToken) {
                var mParameters = {
                    success: function (oData) {
                        var aPage = (oData && oData.results) ? oData.results : [];
                        aAllResults = aAllResults.concat(aPage);

                        if (oData.__next) {
                            // More pages available — extract skiptoken and recurse
                            var sNext = oData.__next.split("$skiptoken=")[1];
                            var sNextToken = sNext ? decodeURIComponent(sNext) : null;
                            if (sNextToken) {
                                readPage(sNextToken);
                                return;
                            }
                        }

                        // ── All pages loaded — finalise ───────────────────────
                        if (aAllResults.length === 0) {
                            that._bAllPagesLoaded = false;
                            that.getView().getModel("TableDataModel").setData({ results: [] });
                            sap.ui.core.BusyIndicator.hide();
                            MessageBox.information(
                                "No records found for the selected criteria.\n\n" +
                                "From Date : " + that.byId("idFromDate").getValue() + "\n" +
                                "To Date   : " + that.byId("idToDate").getValue() + "\n" +
                                "Division  : " + that.byId("idDivision").getValue(),
                                { title: "No Data Found" }
                            );
                            return;
                        }

                        // ── Append Grand Total as last row in TableDataModel ──
                        var oTotal = that._computeGrandTotal(aAllResults);
                        aAllResults.push(oTotal);

                        // Signal all pages loaded — onTableUpdateFinished will hide busy
                        that._bAllPagesLoaded = true;
                        that.getView().getModel("TableDataModel").setData({ results: aAllResults });
                    },

                    error: function (oError) {
                        sap.ui.core.BusyIndicator.hide();
                        that.getView().getModel("TableDataModel").setData({ results: [] });

                        var sMsg = that._parseODataError(oError);
                        MessageBox.error(sMsg, {
                            title: "Error",
                            details: oError.responseText || "",
                            styleClass: that.getOwnerComponent().getContentDensityClass
                                ? that.getOwnerComponent().getContentDensityClass()
                                : ""
                        });
                    }
                };

                // Attach skiptoken only for pages 2, 3, ...
                if (sSkipToken) {
                    mParameters.urlParameters = { "$skiptoken": sSkipToken };
                }

                oModel.read(sPath, mParameters);
            }

            // First page — no skiptoken
            readPage();
        },

        onTableUpdateStarted: function () {
            sap.ui.core.BusyIndicator.show(0);
        },

        onTableUpdateFinished: function () {
            if (this._bAllPagesLoaded) {
                this._bAllPagesLoaded = false;
            }
            sap.ui.core.BusyIndicator.hide();
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
                "TaxableValue", "EdRecovery", "ExciseDuty", "NetTaxableValue",
                "TaxVatRs",
                "Igst", "Cgst", "Sgst", "Tcs",
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

            // Round totals and keep as numbers (Float type binding needs numbers, not strings)
            var aQtyFields = ["BillingQuantity", "DailyAuthQty"];
            aSumFields.forEach(function (sField) {
                var iDecimals = aQtyFields.indexOf(sField) !== -1 ? 3 : 2;
                oTotal[sField] = parseFloat(oTotal[sField].toFixed(iDecimals));
            });

            // ── Text/label fields ─────────────────────────────────────────────
            oTotal.BillingDocumentDate = null;
            oTotal.InvoiceMonthName = "";
            oTotal.FiscalYear = "";
            oTotal.BillingDocument = "";
            oTotal.BillingDocumentItem = "";
            oTotal.BillingDocumentTypeText = "";
            oTotal.OverallBillingStatus = "";
            oTotal.SalesDistrictName = "";
            oTotal.SalesGroupName = "";
            oTotal.CustomerGroupName = "";
            oTotal.ProfitCenter = "";
            oTotal.SoldToParty = "";   // FIX: was missing
            oTotal.SoldToName = "";   // FIX: was missing
            oTotal.ShipToParty = "";
            oTotal.ShipToName = "";
            oTotal.Plant = "";
            oTotal.Material = "";
            oTotal.BillingDocumentItemText = "";
            oTotal.BillingQuantityUnit = "";
            oTotal.SalesOrderDistributionChannel = "";
            oTotal.DailyAuthUnit = "";
            oTotal["class"] = "";
            oTotal.TransactionCurrency = "";

            // ── FIX: Float-bound % fields must be null, NOT ""  ──────────────
            // sap.ui.model.type.Float throws FormatException on empty string
            // which can prevent the grand total row from rendering.
            // null is handled gracefully — the cell just shows blank.
            oTotal.TaxRatePer = null;
            oTotal.IgstPer = null;
            oTotal.CgstPer = null;
            oTotal.SgstPer = null;
            oTotal.TcsPer = null;

            return oTotal;
        },

        // ─── Date formatter for first column ─────────────────────────────────────
        // Shows "Grand Total" for the total row, formatted date for data rows
        formatInvoiceDate: function (oDate, bIsGrandTotal) {
            if (bIsGrandTotal) { return "Grand Total"; }
            if (!oDate) { return ""; }
            var d = oDate instanceof Date ? oDate : new Date(oDate);
            if (isNaN(d.getTime())) { return ""; }
            return ("0" + d.getDate()).slice(-2) + "/" +
                ("0" + (d.getMonth() + 1)).slice(-2) + "/" +
                d.getFullYear();
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
                    var oParser = new DOMParser();
                    var oXmlDoc = oParser.parseFromString(sRaw, "application/xml");
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

        onValueHelpCancel: function () {
            this._oDivDialog.close();
        },

        onDivisionSearch: function (oEvent) {
            var sQuery = oEvent.getParameter("value");
            var oFilter = new Filter("Division", FilterOperator.Contains, sQuery);
            oEvent.getSource().getBinding("items").filter(sQuery ? [oFilter] : []);
        },

        // ─── Sort Function ─────────────────────────────────────────────────────────
        onSortButtonPressed: function () {
            var oView = this.getView();
            if (!this._oSortDialog) {
                Fragment.load({
                    id: oView.getId(),
                    name: "com.bgl.app.salesregister.Fragment.SortDialog",
                    controller: this
                }).then(function (oDialog) {
                    this._oSortDialog = oDialog;
                    oView.addDependent(oDialog);
                    oDialog.open();
                }.bind(this));
            } else {
                this._oSortDialog.open();
            }
        },
        onSortConfirm: function (oEvent) {
            var oSortItem = oEvent.getParameter("sortItem");
            var bDescending = oEvent.getParameter("sortDescending");

            if (!oSortItem) { return; }

            var sSortKey = oSortItem.getKey();

            // Get current data, exclude grand total row, sort, re-append grand total
            var aResults = this.getView().getModel("TableDataModel").getProperty("/results") || [];
            var oGrandTotal = aResults.find(function (r) { return r.IsGrandTotal; });
            var aData = aResults.filter(function (r) { return !r.IsGrandTotal; });

            aData.sort(function (a, b) {
                var vA = a[sSortKey] || "";
                var vB = b[sSortKey] || "";
                // Date fields — compare as Date objects
                if (sSortKey === "BillingDocumentDate") {
                    vA = vA ? new Date(vA).getTime() : 0;
                    vB = vB ? new Date(vB).getTime() : 0;
                }
                if (vA < vB) { return bDescending ? 1 : -1; }
                if (vA > vB) { return bDescending ? -1 : 1; }
                return 0;
            });

            if (oGrandTotal) { aData.push(oGrandTotal); }

            this.getView().getModel("TableDataModel").setProperty("/results", aData);
        },

        // ─── Excel Export ─────────────────────────────────────────────────────────
        onExport: function () {
            var aAllRows = this.getView().getModel("TableDataModel").getProperty("/results") || [];

            // // Build export array — for grand total row put label in BillingDocumentDate (col 1)
            // var aExportRows = aAllRows.map(function (oRow) {
            //     var oExport = Object.assign({}, oRow);
            //     if (oExport.IsGrandTotal) {
            //         oExport.BillingDocumentDate = "Grand Total";  // leftmost column
            //         oExport.BillingDocument = "";                 // clear Invoice No
            //     }
            //     return oExport;
            // });

            var aNumericFields = [
                "BillingQuantity", "PriceToUpdate", "TradeMargin", "DiscountExcl", "ExciseDutySt",
                "TaxableValue", "EdRecovery", "ExciseDuty", "NetTaxableValue", "TaxRatePer",
                "TaxVatRs", "Igst", "IgstPer", "Cgst", "CgstPer", "Sgst", "SgstPer",
                "Tcs", "TcsPer", "InvoiceValue", "DailyAuthQty"
            ];

            // var aExportRows = aAllRows.map(function (oRow) {
            //     var oExport = Object.assign({}, oRow);
            //     if (oExport.IsGrandTotal) {
            //         oExport.BillingDocumentDate = "Grand Total";
            //         oExport.BillingDocument = "";
            //     }
            //     // Convert string decimals to numbers so Excel scale formatting works correctly
            //     aNumericFields.forEach(function (sField) {
            //         if (oExport[sField] !== null && oExport[sField] !== undefined) {
            //             oExport[sField] = parseFloat(oExport[sField]) || 0;
            //         }
            //     });
            //     return oExport;
            // });

            var aExportRows = aAllRows.map(function (oRow) {
                var oExport = Object.assign({}, oRow);
                if (oExport.IsGrandTotal) {
                    oExport.BillingDocumentDate = "Grand Total";
                    oExport.BillingDocument = "";
                } else {
                    // Format date as DD/MM/YYYY for Excel (same as table display)
                    if (oExport.BillingDocumentDate) {
                        var d = oExport.BillingDocumentDate instanceof Date
                            ? oExport.BillingDocumentDate
                            : new Date(oExport.BillingDocumentDate);
                        if (!isNaN(d.getTime())) {
                            oExport.BillingDocumentDate =
                                ("0" + d.getDate()).slice(-2) + "/" +
                                ("0" + (d.getMonth() + 1)).slice(-2) + "/" +
                                d.getFullYear();
                        }
                    }
                }
                // Convert string decimals to numbers so Excel scale formatting works correctly
                aNumericFields.forEach(function (sField) {
                    if (oExport[sField] !== null && oExport[sField] !== undefined) {
                        oExport[sField] = parseFloat(oExport[sField]) || 0;
                    }
                });
                return oExport;
            });

            var oSettings = {
                workbook: { columns: this._createColumnConfig() },
                dataSource: aExportRows,
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
                { label: "Invoice Date", property: "BillingDocumentDate", type: EdmType.String },
                { label: "Invoice Month", property: "InvoiceMonthName", type: EdmType.String },
                { label: "Fiscal Year", property: "FiscalYear", type: EdmType.String },
                { label: "Invoice No", property: "BillingDocument", type: EdmType.String },
                { label: "Sold To Code", property: "SoldToParty", type: EdmType.String },
                { label: "Sold To Name", property: "SoldToName", type: EdmType.String },
                { label: "Sale Type", property: "BillingDocumentTypeText", type: EdmType.String },
                { label: "Billing Document Status", property: "OverallBillingStatus", type: EdmType.String },
                { label: "Sales District (Charge Area)", property: "SalesDistrictName", type: EdmType.String },
                { label: "Acct Assmt Grp Cust./Sales Grp", property: "SalesGroupName", type: EdmType.String },
                { label: "Customer Type", property: "CustomerGroupName", type: EdmType.String },
                { label: "Item", property: "BillingDocumentItem", type: EdmType.String },
                { label: "Profit Centre", property: "ProfitCenter", type: EdmType.String },
                { label: "Ship To Code", property: "ShipToParty", type: EdmType.String },
                { label: "Ship To Name", property: "ShipToName", type: EdmType.String },
                { label: "GA of BGL", property: "Plant", type: EdmType.String },
                { label: "Material Code", property: "Material", type: EdmType.String },
                { label: "Material Name", property: "BillingDocumentItemText", type: EdmType.String },
                { label: "Billing Quantity", property: "BillingQuantity", type: EdmType.Decimal, scale: 3 },
                { label: "Billing UOM", property: "BillingQuantityUnit", type: EdmType.String },

                // ── Pricing / Yellow columns ──────────────────────────────────────
                { label: "Price to Update", property: "PriceToUpdate", type: EdmType.Decimal, scale: 2 },
                { label: "Trade Margin", property: "TradeMargin", type: EdmType.Decimal, scale: 2 },
                { label: "Discount Excluding", property: "DiscountExcl", type: EdmType.Decimal, scale: 2 },
                { label: "Excise Duty ST", property: "ExciseDutySt", type: EdmType.Decimal, scale: 2 },
                { label: "Taxable Value (Rs.)", property: "TaxableValue", type: EdmType.Decimal, scale: 2 },
                { label: "ED Recovery", property: "EdRecovery", type: EdmType.Decimal, scale: 2 },
                { label: "Excise Duty", property: "ExciseDuty", type: EdmType.Decimal, scale: 2 },
                { label: "Net Taxable Value (Rs.)", property: "NetTaxableValue", type: EdmType.Decimal, scale: 2 },
                { label: "Tax Rate % (VAT)", property: "TaxRatePer", type: EdmType.Decimal, scale: 2 },
                { label: "Tax (Rs.) - VAT", property: "TaxVatRs", type: EdmType.Decimal, scale: 2 },
                { label: "IGST", property: "Igst", type: EdmType.Decimal, scale: 2 },
                { label: "IGST %", property: "IgstPer", type: EdmType.Decimal, scale: 2 },
                { label: "CGST", property: "Cgst", type: EdmType.Decimal, scale: 2 },
                { label: "CGST %", property: "CgstPer", type: EdmType.Decimal, scale: 2 },
                { label: "SGST", property: "Sgst", type: EdmType.Decimal, scale: 2 },
                { label: "SGST %", property: "SgstPer", type: EdmType.Decimal, scale: 2 },
                { label: "TCS", property: "Tcs", type: EdmType.Decimal, scale: 2 },
                { label: "TCS %", property: "TcsPer", type: EdmType.Decimal, scale: 2 },

                // ── Summary / Green columns ───────────────────────────────────────
                { label: "Invoice Value (Rs.)", property: "InvoiceValue", type: EdmType.Decimal, scale: 2 },
                { label: "Class", property: "class", type: EdmType.String },
                { label: "Distribution Channel", property: "SalesOrderDistributionChannel", type: EdmType.String },
                { label: "Daily Authorized Quantity", property: "DailyAuthQty", type: EdmType.Decimal, scale: 3 },
                { label: "Daily Authorized Quantity (UOM)", property: "DailyAuthUnit", type: EdmType.String }
            ];
        }
    });
});