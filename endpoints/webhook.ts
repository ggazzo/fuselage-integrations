import { IHttp, IModify, IPersistence, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import { ApiEndpoint, IApiEndpointInfo, IApiRequest, IApiResponse } from '@rocket.chat/apps-engine/definition/api';
import { IMessage } from '@rocket.chat/apps-engine/definition/messages';
import { RocketChatAssociationModel, RocketChatAssociationRecord } from '@rocket.chat/apps-engine/definition/metadata';
import { IRoom } from '@rocket.chat/apps-engine/definition/rooms';
import { BlockElementType, IImageElement, TextObjectType } from '@rocket.chat/apps-engine/definition/uikit';
import type { FuselageIntegrationsApp } from '../FuselageIntegrationsApp';

enum EVENT_TYPES {
    PULL_REQUEST = 'pull_request',
    PULL_REQUEST_REVIEW = 'pull_request_review',
}

type User = {
    login: string;
    avatar_url: string;
};

type PullRequest =  {
    id: number;
    html_url: string;
    url: string;
    title: string;
    body: string;
    user: User;
    number: number;
    requested_teams: Array<{
        name: string;
        slug: string;
    }>;
};

type Reviews = {
    id: string;
    state: 'APPROVED' | 'CHANGES_REQUESTED';
    user: User;
};

type GithubActionPullRequest = {
    action: 'opened' | 'edited' | 'closed' | 'assigned' | 'unassigned' | 'review_requested' | 'review_request_removed' | 'ready_for_review' | 'labeled' | 'unlabeled' | 'synchronize' | 'locked' | 'unlocked';
    number: number;
    pull_request: PullRequest;
};

type GithubActionPullRequestReview = {
    action: 'submitted' | 'dismissed';
    pull_request: PullRequest;
    review: {
        id: 'string';
        user: User
        state: 'approved';
    };
};

type PullRequestRelation = {
    mid: string;
    rid: string;
};

export class WebHook extends ApiEndpoint {
    public path: string = 'webhook';

    public app: FuselageIntegrationsApp;

    public get(request: IApiRequest, endpoint: IApiEndpointInfo, read: IRead, modify: IModify, http: IHttp, persis: IPersistence) {
        this.app.getLogger().log(request);
        return this.success({ ok: true });
    }

    public async post(request: IApiRequest, endpoint: IApiEndpointInfo, read: IRead,
                      modify: IModify, http: IHttp, persis: IPersistence): Promise<IApiResponse> {

        const userApp = await read.getUserReader().getAppUser(this.app.getID());

        const makeBlocks = (reviews: Array<Reviews>, pr: PullRequest) => {
            const blockBuilder = modify.getCreator().getBlockBuilder();

            blockBuilder.addSectionBlock({
                text: {
                    type: TextObjectType.MARKDOWN,
                    text: `*${ pr.title }* [#${pr.number}](${ pr.html_url })`,
                },
                accessory: {
                    type: BlockElementType.IMAGE,
                    imageUrl: pr.user.avatar_url,
                    altText: pr.user.login,
                },
            });

            if (reviews.length) {

                const appproved: Array<IImageElement> = reviews.filter((review) => review.state === 'APPROVED' ).map((review) => ({
                    type: BlockElementType.IMAGE,
                    imageUrl: review.user.avatar_url,
                    altText: review.user.login,
                }));

                if (appproved.length) {
                    blockBuilder.addContextBlock({ elements: [
                        {
                            type: TextObjectType.MARKDOWN,
                            text: '*Approved*',
                        },
                        ...appproved,
                    ] });
                }

                const changesRequested: Array<IImageElement> = reviews.filter((review) => review.state === 'CHANGES_REQUESTED' ).map((review) => ({
                    type: BlockElementType.IMAGE,
                    imageUrl: review.user.avatar_url,
                    altText: review.user.login,
                }));

                if (changesRequested.length) {
                    blockBuilder.addContextBlock({ elements: [
                        {
                            type: TextObjectType.MARKDOWN,
                            text: '*Changes Requested*',
                        },
                        ...changesRequested,
                    ] });
                }
            }

            return blockBuilder;
        };

        const getRooms = (requestedTeams) => requestedTeams.map(({ name }) => this.app.getRoomForTeam(name)).filter(Boolean);

        const fetchAndPersist = async (pull_request: PullRequest): Promise<void> => {
            try {
                if (!userApp) {
                    return;
                }

                const association = new RocketChatAssociationRecord(RocketChatAssociationModel.MISC, pull_request.id.toString());
                const [assocs] = await read.getPersistenceReader().readByAssociation(association) as Array<Array<PullRequestRelation>>;

                const rooms: Array<{
                    mid?: string;
                    rid: string;
                }> = [];
                if (assocs) {
                    assocs.forEach((room) => rooms.push(room));
                }

                getRooms(pull_request.requested_teams).forEach((room) => {
                    if (rooms.find(({ rid }) => rid === room)) {
                        return;
                    }
                    rooms.push({ rid: room });
                });

                if (rooms.length === 0) {
                    return;
                }

                for (const assoc of rooms) {
                    const { mid, rid } = assoc;

                    const room = await read.getRoomReader().getById(rid);
                    if (!room) {
                        return;
                    }

                    const message = mid
                        ? await (await modify.getUpdater().message(mid, userApp)).setEditor(userApp)
                        : await modify.getCreator().startMessage()
                            .setEmojiAvatar(':mage:').setRoom(room);

                    const finisher = mid ? modify.getUpdater() : modify.getCreator();

                    const response = await (await http.get(`${pull_request.url}/reviews`, {
                        headers: {
                            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 11_1_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.96 Safari/537.36',
                        },
                    }));

                    const reviews: Array<Reviews> = response.data;

                    const blockBuilder = makeBlocks(reviews, pull_request);

                    message.setBlocks(blockBuilder);

                    const newId = await finisher.finish(message);
                    if (newId) {
                        assoc.mid = newId;
                    }
                }

                if (!assocs) {
                    await persis.createWithAssociation(rooms, association);
                } else {
                    await persis.updateByAssociation(association, rooms);
                }

                return;
            } catch (error) {
                this.app.getLogger().error(error);
            }
        };

        const handlePullRequest = async (): Promise<IApiResponse> => {
            const { action , pull_request }: GithubActionPullRequest = JSON.parse(request.content.payload);

            switch (action) {
                case 'review_requested':
                case 'opened':
                case 'edited':
                    // this.app.getLogger().log('here');
                    await fetchAndPersist(pull_request);
                    break;
            }
            return this.success({ ok: true });
        };

        const handlePullRequestReview = async (): Promise<IApiResponse> => {
            const { action, review , pull_request }: GithubActionPullRequestReview = JSON.parse(request.content.payload);

            switch (action) {
                case 'dismissed':
                case 'submitted':

                    await fetchAndPersist(pull_request);
                    break;
            }
            return this.success({ ok: true });
        };

        // this.app.getLogger().log(request);
        if (request.headers['x-github-event'] === EVENT_TYPES.PULL_REQUEST) {
            return handlePullRequest();
        }
        if (request.headers['x-github-event'] === EVENT_TYPES.PULL_REQUEST_REVIEW) {
            return handlePullRequestReview();
        }
        return this.success({ ok: true });
    }
}
