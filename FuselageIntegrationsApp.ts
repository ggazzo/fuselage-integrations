import {
    IAppAccessors,
    IConfigurationExtend,
    ILogger,
} from '@rocket.chat/apps-engine/definition/accessors';
import { ApiSecurity, ApiVisibility } from '@rocket.chat/apps-engine/definition/api';
import { App } from '@rocket.chat/apps-engine/definition/App';
import { IAppInfo } from '@rocket.chat/apps-engine/definition/metadata';
import { SettingType } from '@rocket.chat/apps-engine/definition/settings';
import { WebHook } from './endpoints/webhook';

export class FuselageIntegrationsApp extends App {
    private TEAM_ROOMS: Record<string, string> = {};

    constructor(info: IAppInfo, logger: ILogger, accessors: IAppAccessors) {
        super(info, logger, accessors);
    }

    public async onEnable(environmentRead) {
        const teamRooms = await environmentRead.getSettings().getValueById('TEAM_ROOM');

        // TODO update TEAM_ROOMS every time the setting is saved
        teamRooms.split(',').forEach((teamRoom) => {
            const [team, room] = teamRoom.split(':');
            this.TEAM_ROOMS[team] = room;
        });

        return true;
    }

    public getRoomForTeam(team: string): string {
        // console.log('this.TEAM_ROOMS ->', team, this.TEAM_ROOMS);
        return this.TEAM_ROOMS[team];
    }

    protected async extendConfiguration(configuration: IConfigurationExtend): Promise<void> {
        await configuration.api.provideApi({
            visibility: ApiVisibility.PUBLIC,
            security: ApiSecurity.UNSECURE,
            endpoints: [
                new WebHook(this),
            ],
        });

        configuration.settings.provideSetting({
            id: 'TEAM_ROOM',
            type: SettingType.STRING,
            packageValue: '',
            required: true,
            public: false,
            i18nLabel: 'TEAM_ROOM',
        });
    }
}
