import cockpit from 'cockpit';
import React from 'react';

import { UIButton } from './common/nextbutton.jsx';
import '../app.scss';
import { allVars, osdsVars, monsVars, mgrsVars, hostVars, rgwsVars, iscsiVars, cephAnsibleSequence, dashboardVars } from '../services/ansibleMap.js';
import { storeGroupVars, storeHostVars, runPlaybook, getPlaybookState, getEvents, getJobEvent } from '../services/apicalls.js';
import { ElapsedTime } from './common/timer.jsx';
import { Selector } from './common/selector.jsx';
import { GenericModal } from './common/modal.jsx';
import { InfoBar } from './common/infobar.jsx';
import { buildRoles, currentTime, convertRole, versionSupportsMetrics, writeFile } from '../services/utils.js';

export class DeployPage extends React.Component {
    //
    // Implements the deployment page that handles the creation of the ansible artifacts and
    // the UI monitoring of playbook execution
    constructor(props) {
        super(props);
        this.state = {
            roleSequence: [],
            deployEnabled: true,
            backBtnEnabled: true,
            deployBtnText: 'Save',
            statusMsg: '',
            deployActive: false,
            settings: {},
            runTime: 0,
            showTaskStatus: true,
            startTime: 'N/A',
            roleState: {},
            infoTip: "When you click 'Save', the Ansible settings will be committed to disk using standard " +
                     "Ansible formats. This allows you to refer to or modify these settings before " +
                     "starting the deployment.",
            status: {
                status: 'ready',
                msg: "Waiting to start",
                data: {
                    ok: 0,
                    failed: 0,
                    skipped: 0,
                    role: '',
                    task: '',
                    task_metadata: {
                        created: '',
                        task_action: '',
                        task_path: '',
                        play_pattern: ''
                    }
                }
            }
        };
        this.deploySelector = [
            'Current task',
            'Failed task(s)'
        ];
        this.startTime = 'N/A';
        this.endTime = null;
        this.roleActive = null;
        this.roleSeen = [];
        this.mocked = false;
        this.playbookUUID = '';
        this.intervalHandler = 0;
        this.activeMockData = [];
        this.mockEvents = [];
        this.mockCephOutput = [];
        this.defaultInfoTip = "";
    }

    componentDidMount() {
        console.log("checking for mock data for the deployment");
        this.defaultInfoTip = this.state.infoTip;

        cockpit.file("/var/lib/cockpit/ceph-installer/mockdata/deploypage.json").read()
                .done((content, tag) => {
                    if (content === null && tag === '-') {
                        console.log("No mockdata present for deploypage");
                    } else {
                        let mockData = JSON.parse(content);
                        console.log("mock data loaded");
                        this.mocked = true;
                        this.mockEvents = mockData['mockEvents'];
                        console.log("mock events :" + this.mockEvents.length);
                        this.mockCephOutput = mockData['mockCephOutput'];
                        console.log("mock ceph output lines : " + this.mockCephOutput.length);
                    }
                })
                .fail((error) => {
                    console.log("file read failed :" + JSON.stringify(error));
                });
    }

    static getDerivedStateFromProps(nextProps, prevState) {
        if (JSON.stringify(nextProps.settings) != JSON.stringify(prevState.settings)) {
            let allRoles = buildRoles(nextProps.settings.hosts);
            let tmpRoleState = {};
            for (let role of allRoles) {
                if (role == 'grafana-server') {
                    tmpRoleState['metrics'] = 'pending';
                } else {
                    tmpRoleState[role] = 'pending';
                }
                if (role == 'mons') { tmpRoleState['mgrs'] = 'pending' }
            }

            return {
                settings: nextProps.settings,
                roleState: tmpRoleState,
                roleSequence: cephAnsibleSequence(allRoles)
            };
        } else {
            return null;
        }
    }

    setRoleState = (eventData) => {
        let currentState = this.state.roleState;
        let changesMade = false;
        let eventRoleName;
        let shortName;

        // Most roles are prefixed by ceph- but we need to handle the exceptions too
        let taskRole = (eventData.data.role || eventData.data.task_metadata.role);
        switch (taskRole) {
        case "grafana-server":
            shortName = 'grafana';
            break;
        default:
            if (taskRole) {
                shortName = taskRole.replace("ceph-", "");
            } else {
                shortName = '';
            }
            break;
        }

        eventRoleName = convertRole(shortName);

        console.log("Debug: role sequence is " + JSON.stringify(this.state.roleSequence));
        switch (eventData.msg) {
        case "running":
            if (this.roleActive == null) {
                // first time through
                currentState['mons'] = 'active';
                this.roleActive = 'mons';
                changesMade = true;
                break;
            } else {
                if (eventRoleName) {
                    console.log("Current role active: " + this.roleActive + ", eventRoleName: " + eventRoleName + ", shortName: " + shortName);

                    // if the event role is not in the list AND we have seen the role-active name before
                    // - set the current role to complete and move to the next role in the ansible sequence
                    if (!this.state.roleSequence.includes(shortName) && this.roleSeen.includes(convertRole(this.roleActive))) {
                        currentState[this.roleActive] = 'complete';
                        console.log("converting role active of " + this.roleActive);
                        let a = convertRole(this.roleActive); // remove the 's'
                        let nextRole = this.state.roleSequence[this.state.roleSequence.indexOf(a) + 1];
                        console.log("next role is " + nextRole);
                        let nextRoleName = convertRole(nextRole);
                        currentState[nextRoleName] = 'active';
                        console.log("role active set to " + nextRoleName);
                        this.roleActive = nextRoleName;
                        changesMade = true;
                    }

                    // if the shortname is in the sequence, but not in last seen
                    // - add it to last seen and move us along the breadcrumb trail
                    if (!this.roleSeen.includes(shortName) && this.state.roleSequence.includes(shortName)) {
                        console.log("not seen this role " + shortName + " before, adding to our list ");
                        currentState[this.roleActive] = 'complete';
                        currentState[eventRoleName] = 'active';
                        this.roleActive = eventRoleName;
                        changesMade = true;
                        this.roleSeen.push(shortName);
                    }
                }
            }
            break;
        case "failed":
            currentState[this.roleActive] = 'failed'; // mark current breadcrumb as failed
            changesMade = true;
            break;
        case "successful":
            currentState[this.roleActive] = 'complete'; // mark current breadcrumb as complete
            changesMade = true;
            break;
        }

        if (changesMade) {
            this.setState({roleState: currentState});
        }
        console.log("roles seen " + this.roleSeen);
    }

    formattedOutput = (output) => {
        var urlRegex = /(https?:\/\/[^\s]+)/g;
        var cmdOutput = output.map((textLine, idx) => {
            let match = urlRegex.exec(textLine);
            let parts;
            if (match) {
                parts = textLine.split(match[0]);
                return (
                    <div key={idx} className="code">
                        { parts[0] }
                        <a href={match[0]} rel="noopener noreferrer" target="_blank"> {match[0]} </a>
                        { parts[1] }
                    </div>);
            } else {
                return (<div key={idx} className="code">{ textLine }</div>);
            }
        });

        return (
            <div>
                { cmdOutput }
            </div>
        );
    }

    fetchCephState = () => {
        console.log("querying events for " + this.playbookUUID);
        var foundEvents = [];
        var content = [];

        if (this.mocked) {
            // just return the mocked data output
            console.log("using mocked data");
            console.log("calling the main app modal");
            this.props.modalHandler("Ceph Cluster Status", this.formattedOutput(this.mockCephOutput));
        } else {
            console.log("fetching event data from the playbook run");
            getEvents(this.playbookUUID)
                    .then((resp) => {
                        let response = JSON.parse(resp);
                        let matchCount = (versionSupportsMetrics(this.props.settings.cephVersion)) ? 2 : 1;
                        console.log("Debug: Looking for " + matchCount + " job events in the playbook stream");
                        // process the events in reverse order, since what we're looking for is at the end of the run
                        let evtIDs = Object.keys(response.data.events).reverse();
                        for (let evt of evtIDs) {
                            let thisEvent = response.data.events[evt];
                            let task = thisEvent['task'];
                            if ((thisEvent['event'] === 'runner_on_ok') &&
                                (task.startsWith('show ceph status for') || task.startsWith('print dashboard URL'))) {
                                console.log("ceph status event " + JSON.stringify(thisEvent));
                                foundEvents.push(evt);
                                if (foundEvents.length == matchCount) {
                                    console.log("Debug: found all required matches");
                                    break;
                                }
                            }
                        }
                        if (foundEvents) {
                            // build iterable containing all the promises
                            let events = [];
                            for (let eventID of foundEvents) {
                                let promise = getJobEvent(this.playbookUUID, eventID);
                                events.push(promise);
                            }
                            // wait for all promises to resolve
                            Promise.all(events).then((values) => {
                                // values will be a list of response objects
                                console.log(JSON.stringify(values));
                                for (let resp of values) {
                                    let response = JSON.parse(resp);
                                    let output = response.data.event_data.res.msg;

                                    if (Array.isArray(output)) {
                                        // put multi-line output first
                                        content.unshift(...output);
                                    } else {
                                        // place single line output at the end
                                        content.push(output);
                                    }
                                }
                                this.props.modalHandler("Ceph Cluster Status", this.formattedOutput(content));
                            });
                        } else {
                            console.log("No events to provide end of install information");
                        }
                    })
                    .catch(e => {
                        console.error("Unable to fetch events for playbook run " + this.playbookUUID);
                    });
        }
    }

    reset = () => {
        let allRoles = buildRoles(this.props.settings.hosts);
        let tmpRoleState = {};
        for (let role of allRoles) {
            tmpRoleState[role] = 'pending';
            if (role == 'mons') { tmpRoleState['mgrs'] = 'pending' }
        }
        this.roleSeen = [];
        this.roleActive = null;
        this.setState({
            status: {
                status: 'ready',
                msg: "Waiting to start",
                data: {
                    ok: 0,
                    failed: 0,
                    skipped: 0,
                    role: '',
                    task: ''
                }
            },
            roleState: tmpRoleState
        });
    }

    storeAnsibleVars = () => {
        console.log("Creating the hostvars and groupvars variables");
        let roleList = buildRoles(this.state.settings.hosts);
        console.log("Generating variables for roles " + roleList);
        var vars = allVars(this.state.settings);
        console.log("creating all.yml as " + JSON.stringify(vars));
        var chain = Promise.resolve();
        let mons, mgrs, osds, rgws, iscsi, dashboards;
        chain = chain.then(() => storeGroupVars('all', vars));

        for (let roleGroup of roleList) {
            switch (roleGroup) {
            case "mons":
                console.log("adding mons + mgrs");
                mons = monsVars(this.state.settings);
                console.log("mon vars " + JSON.stringify(mons));
                chain = chain.then(() => storeGroupVars('mons', mons));
                mgrs = mgrsVars(this.state.settings);
                console.log("mgr vars " + JSON.stringify(mgrs));
                chain = chain.then(() => storeGroupVars('mgrs', mgrs));
                break;
            case "osds":
                console.log("adding osds");
                osds = osdsVars(this.state.settings);
                console.log("osd vars " + JSON.stringify(osds));
                chain = chain.then(() => storeGroupVars('osds', osds));
                break;
            case "mdss":
                console.log("adding mds yml - Just using ceph-ansible defaults...FIXME?");
                break;
            case "rgws":
                console.log("adding rgws yml");
                rgws = rgwsVars(this.state.settings);
                chain = chain.then(() => storeGroupVars('rgws', rgws));
                break;
            case "iscsigws":
                console.log("adding iscsigws yml");
                iscsi = iscsiVars(this.state.settings);
                chain = chain.then(() => storeGroupVars('iscsigws', iscsi));
                break;
            case "grafana-server":
                console.log("adding dashboards.yml");
                dashboards = dashboardVars(this.state.settings);
                chain = chain.then(() => storeGroupVars('dashboards', dashboards));
                break;
            }
        }

        console.log("all group vars have been added");
        if (roleList.includes("osds")) {
            console.log("generating hostvars for the osd hosts");
            for (let host of this.state.settings.hosts) {
                if (host.osd) {
                    let osd_metadata = hostVars(host, this.state.settings.flashUsage);
                    chain = chain.then(() => storeHostVars(host.hostname, 'osds', osd_metadata));
                }
            }
        }
        chain.then(() => this.setState(
            { deployBtnText: "Deploy",
              infoTip: "Variables have been stored within the host_vars and group_vars directories of /usr/share/ceph-ansible."}));
        chain.catch(err => {
            console.error("Problem creating group vars files: " + err);
            this.props.modalHandler("Unable to create Ansible Variables",
                                    "Failed to create the Ansible hostvars/groupvars files. Use the error messages " +
                                    "in the web browsers console log to determine failure");
        });
    }

    deployBtnHandler = () => {
        // user clicked deploy/Complete or retry button (multi-personality syndrome)
        console.log("User clicked the Save/Deploy/Complete/Retry button");
        console.log("current app state is;");
        console.log(JSON.stringify(this.state.settings));

        switch (this.state.deployBtnText) {
        case "Complete":
            this.fetchCephState();
            break;
        case "Save":
            this.storeAnsibleVars();
            break;
        case "Deploy":
        case "Retry":
            this.props.deployHandler(); // turns on deployStarted flag
            this.reset();
            this.setState({
                deployActive: true,
                deployBtnText: 'Running',
                infoTip: "",
                deployEnabled: false,
                backBtnEnabled: false
            });
            this.startPlaybook();
        }
    }

    saveSettings = () => {
        let now = currentTime();

        // discard any unwanted settings variables that only apply to the UI
        let ignoreList = ["pageNum", "lastPage", "msgText", "msgLevel", "credentialsClass", "modalTitle", "addHostsVisible"];
        let localSettings = JSON.parse(JSON.stringify(this.state.settings));
        ignoreList.forEach(item => {
            delete localSettings[item];
        });

        let fileName = this.state.settings.user.home + "/cockpit-ceph-installer.log";
        let runtimeSettings = {
            playuuid: this.playbookUUID,
            startTime: now,
            settings: localSettings
        };
        writeFile(fileName, JSON.stringify(runtimeSettings, null, 2))
                .done(() => {
                    console.log("DeployPage: Runtime setttings stored in " + fileName);
                })
                .fail(() => {
                    console.error("DeployPage: Failed to store runtime settings in " + fileName);
                });
    }

    startPlaybook = () => {
        console.log("Start playbook and set up timer to refresh every 2secs");
        this.setState({
            startTime: currentTime()
        });

        if (this.mocked) {
            this.activeMockData = this.mockEvents.slice(0);
            this.intervalHandler = setInterval(this.getPlaybookState, 2000);
        } else {
            // Start the playbook
            let playbookName;
            let varOverrides = {};
            if (this.state.settings.installType.toUpperCase() == 'CONTAINER') {
                playbookName = 'site-container.yml';
            } else {
                playbookName = 'site.yml';
            }
            console.log("Attempting to start playbook " + playbookName);
            runPlaybook(playbookName, varOverrides)
                    .then((resp) => {
                        let response = JSON.parse(resp);
                        if (response.status == "STARTED") {
                            this.playbookUUID = response.data.play_uuid;
                            console.log("playbook has started with UUID " + this.playbookUUID);
                            this.saveSettings();
                            this.intervalHandler = setInterval(this.getPlaybookState, 2000);
                        }
                    })
                    .catch(e => {
                        console.log("Problem starting the playbook - unable to continue: " + e + ", " + e.message);
                    });
        }
    }

    getPlaybookState = () => {
        console.log("fetch state from the playbook run");
        if (this.mocked) {
            if (this.activeMockData.length > 0) {
                let mockData = this.activeMockData.shift();
                console.log(JSON.stringify(mockData));
                this.setState({status: mockData});
                this.setRoleState(mockData);
                // TODO: look at the data to determine progress state for the breadcrumb
            } else {
                console.log("All mocked data used up");
                clearInterval(this.intervalHandler);

                let playStatus = this.state.status.msg.toUpperCase();
                console.log("Last status is " + playStatus);

                let buttonText;
                if (playStatus == "SUCCESSFUL") {
                    buttonText = "Complete";
                    this.setState({
                        backBtnEnabled: false,
                        infoTip:"Ceph deployment is complete. Click 'Complete' to show current state and login URL"
                    }); // disables the back button!
                } else {
                    buttonText = "Retry";
                }

                this.endTime = currentTime();
                this.setState({
                    deployActive: false,
                    deployEnabled: true,
                    deployBtnText: buttonText
                });
            }
        } else {
            // this is a real run
            getPlaybookState(this.playbookUUID)
                    .then((resp) => {
                        // process the response
                        let response = JSON.parse(resp);
                        this.setState({status: response});
                        this.setRoleState(response);
                        let msg = response.msg.toUpperCase();
                        let buttonText;
                        let infoTipText;

                        switch (msg) {
                        case "FAILED":
                        case "CANCELED":
                        case "SUCCESSFUL":
                            buttonText = (msg == "SUCCESSFUL") ? "Complete" : "Retry";
                            if (buttonText == "Complete") {
                                infoTipText = "Ceph deployment is complete. Click 'Complete' to show current state and login URL";
                            } else {
                                infoTipText = "Deployment failed. Click the 'Filter by' pulldown to show failed tasks to investigate";
                                // turn the back button back on to allow the user to make config changes
                                this.setState({
                                    backBtnEnabled: true,
                                });
                            }
                            clearInterval(this.intervalHandler);
                            this.refs.timer.stopTimer();
                            this.endTime = currentTime();
                            this.setState({
                                deployActive: false,
                                deployBtnText: buttonText,
                                infoTip: infoTipText,
                                deployEnabled: true
                            });
                            break;
                        default:
                            // play is still active - NO-OP
                        }
                    })
                    .catch(e => {
                        console.log("Problem fetching playbook execution state from runner-service");
                    });
        }
    }

    storeRuntime = (timer) => {
        this.setState({runTime: timer});
    }

    deploymentSwitcher = (event) => {
        console.log("Change of pulldown to " + event.target.value);
        if (event.target.value.startsWith('Current')) {
            this.setState({showTaskStatus: true});
        } else {
            this.setState({showTaskStatus: false});
        }
    }

    previousPage = () => {
        this.setState({
            deployBtnText: "Save",
            infoTip:this.defaultInfoTip});
        this.props.prevPage();
    }

    render() {
        if (this.props.className == 'page') {
            console.log("in deploypage render method");

            var deployBtnClass;
            var msgClass;
            var msgText;
            msgText = this.state.status.msg.charAt(0).toUpperCase() + this.state.status.msg.slice(1);
            switch (this.state.status.msg) {
            case "failed":
                msgClass = "runtime-table-value align-left errorText bold-text";
                break;
            case "successful":
                msgClass = "runtime-table-value align-left success bold-text";
                break;
            default:
                msgClass = "runtime-table-value align-left";
            }

            switch (this.state.deployBtnText) {
            case "Failed":
            case "Retry":
                deployBtnClass = "nav-button btn btn-primary btn-lg";
                break;
            case "Complete":
                deployBtnClass = "nav-button btn btn-success btn-lg";
                break;
            default:
                deployBtnClass = "nav-button btn btn-primary btn-lg";
                break;
            }

            return (
                <div id="deploy" className={this.props.className}>
                    <h3>6. Deploy the Cluster</h3>
                    You are now ready to start the deployment process. Click 'Save' to commit your choices, then 'Deploy' to begin the
                    installation process. <br />
                    <table className="runtime-table">
                        <tbody>
                            <tr>
                                <td className="runtime-table-label">Start Time</td>
                                <td className="runtime-table-value align-left">{this.state.startTime}</td>
                                <td className="runtime-table-spacer">&nbsp;</td>
                                <td className="runtime-table-label">Completed</td>
                                <td className="runtime-table-nbr align-right">{this.state.status.data.ok}</td>
                            </tr>
                            <tr>
                                <td className="runtime-table-label">Status</td>
                                <td className={msgClass}>{msgText}</td>
                                <td className="runtime-table-spacer">&nbsp;</td>
                                <td className="runtime-table-label">Skipped</td>
                                <td className="runtime-table-nbr align-right">{this.state.status.data.skipped}</td>
                            </tr>
                            <tr>
                                <td className="runtime-table-label">Run Time</td>
                                <td className="runtime-table-value align-left">
                                    <ElapsedTime ref="timer" active={this.state.deployActive} callback={this.storeRuntime} />
                                </td>
                                <td className="runtime-table-spacer">&nbsp;</td>
                                <td className="runtime-table-label">Failures</td>
                                <td className="runtime-table-nbr align-right">{this.state.status.data.failed}</td>
                            </tr>
                        </tbody>
                    </table>
                    <BreadCrumbStatus runStatus={ this.state.status.msg } roleState={ this.state.roleState } sequence={ this.state.roleSequence } />
                    <div>
                        <Selector labelName="Filter by:&nbsp;&nbsp;" noformat options={this.deploySelector} callback={this.deploymentSwitcher} />
                    </div>
                    <div id="deploy-container">
                        <TaskStatus visible={this.state.showTaskStatus} status={this.state.status} />
                        <FailureSummary visible={!this.state.showTaskStatus} status={this.state.status} />
                    </div>
                    <div className="nav-button-container">
                        <UIButton btnClass={deployBtnClass} btnLabel={this.state.deployBtnText} disabled={!this.state.deployEnabled} action={this.deployBtnHandler} />
                        <UIButton btnLabel="&lsaquo; Back" disabled={!this.state.backBtnEnabled} action={this.previousPage} />
                        <InfoBar
                            info={this.state.infoTip || ''} />
                    </div>
                </div>
            );
        } else {
            console.log("Skipping render of deploypage - not active");
            return (<div id="deploy" className={this.props.className} />);
        }
    }
}

export class TaskStatus extends React.Component {
    render() {
        let visible = (this.props.visible) ? "deploy-status display-block" : "deploy-status hidden";
        let taskStatus;
        if (this.props.status.msg.startsWith('Waiting')) {
            taskStatus = (<div />);
        } else {
            let taskInfo;
            let timeStamp;
            let taskRole = (this.props.status.data.role || this.props.status.data.task_metadata.role);
            if (taskRole) {
                taskInfo = '[ ' + taskRole + ' ] ' + this.props.status.data.task;
            } else {
                taskInfo = this.props.status.data.task;
            }
            if (this.props.status.data.task_metadata.created) {
                let t = new Date(this.props.status.data.task_metadata.created);
                let offset = t.getTimezoneOffset() / 60;
                t.setHours(t.getHours() - offset);
                timeStamp = t.toLocaleTimeString('en-GB');
            } else {
                timeStamp = '';
            }
            taskStatus = (
                <div>
                    <div>
                        <span className="task-label bold-text">Task Name:</span><span>{taskInfo}</span>
                    </div>
                    <div>
                        <span className="task-label bold-text">Started:</span><span>{timeStamp}</span>
                    </div>
                    <div>
                        <span className="task-label bold-text">Role:</span><span>{taskRole}</span>
                    </div>
                    <div>
                        <span className="task-label bold-text">Pattern:</span><span>{this.props.status.data.task_metadata.play_pattern}</span>
                    </div>
                    <div>
                        <span className="task-label bold-text">Task Path:</span><span>{this.props.status.data.task_metadata.task_path}</span>
                    </div>
                    <div>
                        <span className="task-label bold-text">Action:</span><span>{this.props.status.data.task_metadata.task_action}</span>
                    </div>
                </div>
            );
        }

        return (
            <div className={visible} >
                {taskStatus}
            </div>
        );
    }
}

export class FailureSummary extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            modalVisible: false,
            modalContent: '',
            modalTitle: ''
        };
    }

    showModal = (title, content) => {
        this.setState({
            modalTitle: title,
            modalVisible: true,
            modalContent: content
        });
    }

    hideModal = () => {
        this.setState({
            modalTitle: '',
            modalVisible: false,
            modalContent: ''
        });
    }

    render() {
        var failureRows;
        var failureSection;

        failureSection = (
            <div />
        );

        let visible = (this.props.visible) ? "display-block" : "hidden";

        if (this.props.visible) {
            if (this.props.status.data.failed > 0) {
                let failedHosts = Object.keys(this.props.status.data.failures);
                failureRows = failedHosts.map((host, id, ary) => {
                    let hostError = this.props.status.data.failures[host]['event_data'];
                    return <FailureDetail
                                key={id}
                                hostname={host}
                                errorEvent={hostError}
                                modalHandler={this.showModal} />;
                });

                failureSection = (
                    <table className="failure-table">
                        <thead>
                            <tr>
                                <th className="fhost">Hostname</th>
                                <th className="fdetail">Task Name / Failure Reason</th>
                            </tr>
                        </thead>
                        <tbody>
                            { failureRows }
                        </tbody>
                    </table>
                );
            }
        }

        return (
            <div className={visible}>
                <GenericModal
                    title={this.state.modalTitle}
                    show={this.state.modalVisible}
                    content={this.state.modalContent}
                    closeHandler={this.hideModal} />
                { failureSection }
            </div>
        );
    }
}

export class FailureDetail extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
        };
    }

    // clipboardCopy = () => {
    //     console.log("copying error for " + this.props.hostname + " to the clipboard");
    //     let errorText;
    //     errorText = this.props.hostname + " failed in role '";
    //     errorText += this.props.errorEvent['role'] + "', task '";
    //     errorText += this.props.errorEvent['task'] + "'. Error msg - ";
    //     errorText += this.props.errorEvent['res']['msg'];
    //     copyToClipboard(errorText);
    // }

    render() {
        let errorText;
        let errorDetail;
        let errors = [];

        if (this.props.errorEvent.res.results) {
            console.log("errorEvent: has results array");
            let results = this.props.errorEvent.res.results;
            for (let e of results) {
                if (e.failed) {
                    if (e.hasOwnProperty('msg')) {
                        console.log("errorEvent - using msg");
                        errors.push(e.msg);
                        continue;
                    }
                    if (e.hasOwnProperty('stderr')) {
                        errors.push(e.stderr);
                        console.log("errorEvent - using stderr");
                        continue;
                    }
                } else {
                    console.log("errorEvent processing skipping entry - failed is FALSE");
                }
            }
        } else {
            try {
                errors.push(this.props.errorEvent.res.msg);
            } catch (err) {
                console.log("errorEvent unable to extract a 'msg' field from the event data, trying stderr");
                try {
                    errors.push(this.props.errorEvent.res.stderr);
                } catch (err) {
                    console.log("errorEvent unable to find stderr field");
                }
            }
        }
        console.log("errorEvent has " + errors.length + " items");
        if (errors.length === 0) {
            // if ee don't have any errors there is a parsing problem, so just flag the issue and allow the UI to link
            // out to the raw ansible output.
            errors.push("Unable to interpret the ansible error. Use the link to see actual task output");
        }

        errorText = errors.map((e, idx) => {
            return <span key={idx}>-&nbsp;{e}<br /></span>;
        });

        errorDetail = (
            <span>{errorText}...
                <span className="link" onClick={() => {
                    let title = "Host " + this.props.hostname + " Failure Details";
                    let content = (<pre>{JSON.stringify(this.props.errorEvent, null, 2)}</pre>);
                    this.props.modalHandler(title, content);
                }}><i>&nbsp;more</i></span>
            </span>);

        return (
            <tr>
                <td className="fhost">{this.props.hostname}</td>
                <td className="fdetail">
                    Task:&nbsp;{this.props.errorEvent['task']}<br />
                    { errorDetail }
                </td>
            </tr>
        );
    }
}

export class BreadCrumbStatus extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            roles: []
        };
    }

    static getDerivedStateFromProps(nextProps, prevState) {
        if (prevState.roles.length == 0) {
            console.log("defining the role sequence for the breadcrumbs");
            let converted = nextProps.sequence.map((role, i) => { return convertRole(role) });
            return {roles: converted};
        } else {
            return null;
        }
    }

    render () {
        console.log("render all breadcrumbs - " + JSON.stringify(this.state.roles));
        var breadcrumbs;

        breadcrumbs = this.state.roles.map((role, i) => {
            return <Breadcrumb
                        key={i}
                        label={role}
                        state={this.props.roleState[role]} />;
        });

        return (
            <div className="display-block">
                { breadcrumbs }
            </div>
        );
    }
}

export class Breadcrumb extends React.Component {
    render() {
        console.log("rendering a breadcrumb");
        var status;
        switch (this.props.state) {
        case "active":
            status = "blue";
            break;
        case "complete":
            status = "green";
            break;
        case "failed":
            status = "red";
            break;
        default:
            status = "grey";
            break;
        }

        status += " breadcrumb";
        return (
            <div className={status}>{this.props.label}</div>
        );
    }
}

export default DeployPage;
